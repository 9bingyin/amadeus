import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryCoordinator,
  type MemoryExtractionRunner,
} from "../../src/memory/coordinator";
import { MemoryStore } from "../../src/memory/store";
import type {
  ExtractedMemoryEntry,
  MemoryExtractionJob,
} from "../../src/memory/types";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

class RecordingExtractor implements MemoryExtractionRunner {
  readonly jobs: MemoryExtractionJob[] = [];
  failures = 0;
  result: ExtractedMemoryEntry[] = [];
  pending: Promise<void> | undefined;

  async extract(
    job: MemoryExtractionJob,
    signal?: AbortSignal,
  ): Promise<ExtractedMemoryEntry[]> {
    this.jobs.push(job);
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("temporary failure");
    }
    if (this.pending) {
      await Promise.race([
        this.pending,
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
      ]);
    }
    return this.result;
  }
}

describe("MemoryCoordinator", () => {
  test("mutation 只等待本地持久提交并立即更新 stable snapshot", async () => {
    const fixture = await createFixture();
    const result = await fixture.coordinator.handleRequest({
      kind: "tool",
      chatId: 1,
      sessionId: "s1",
      revision: 1,
      toolCallId: "call-1",
      args: {
        toolName: "memory_write",
        target: "long_term",
        content: "Uses Bun",
      },
    });

    expect(result).toMatchObject({
      status: "completed",
      receiptId: "memory:s1:call-1",
    });
    expect(
      await fixture.coordinator.handleRequest({
        kind: "snapshot",
        chatId: 1,
        sessionId: "s1",
      }),
    ).toMatchObject({
      status: "ready",
      revision: 1,
      content: expect.stringContaining("Uses Bun"),
    });
    await fixture.coordinator.close();
  });

  test("提取失败持久回退，达到时间后可重试并幂等完成", async () => {
    let now = 1_000;
    const extractor = new RecordingExtractor();
    extractor.failures = 1;
    extractor.result = [{ target: "long_term", content: "Recovered fact" }];
    const fixture = await createFixture(extractor, () => now);
    const sessionFile = await writeSession(fixture.directory, "s2");
    await fixture.store.captureSessionRange({
      chatId: 2,
      sessionId: "s2",
      sessionFile,
    });

    expect(await fixture.coordinator.processNextJob()).toBe("retry");
    expect(await fixture.coordinator.processNextJob()).toBe("idle");
    now += 5_000;
    expect(await fixture.coordinator.processNextJob()).toBe("processed");
    expect(await fixture.coordinator.processNextJob()).toBe("idle");
    expect(extractor.jobs.map((job) => job.attempts)).toEqual([1, 2]);
    expect(
      await readFile(join(fixture.memoryDir, "MEMORY.md"), "utf8"),
    ).toContain("Recovered fact");
    await fixture.coordinator.close();
  });

  test("永久提取失败使用有界退避并保留 failed job", async () => {
    let now = 1_000;
    const extractor = new RecordingExtractor();
    extractor.failures = 10;
    const fixture = await createFixture(extractor, () => now);
    const sessionFile = await writeSession(fixture.directory);
    await fixture.store.captureSessionRange({
      chatId: 1,
      sessionId: "s1",
      sessionFile,
    });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = await fixture.coordinator.processNextJob();
      expect(result).toBe(attempt === 5 ? "processed" : "retry");
      now += 5_000 * 2 ** (attempt - 1);
    }
    expect(await fixture.coordinator.processNextJob()).toBe("idle");
    const jobs = await readdir(join(fixture.metadataDir, "jobs"));
    expect(jobs).toHaveLength(1);
    expect(
      JSON.parse(
        await readFile(
          join(fixture.metadataDir, "jobs", jobs[0] ?? ""),
          "utf8",
        ),
      ),
    ).toMatchObject({ status: "failed", attempts: 5 });
    await fixture.coordinator.close();
  });

  test("失败 job 不阻塞同一 session 的后续可运行范围", async () => {
    const processedOffsets: number[] = [];
    const extractor: MemoryExtractionRunner = {
      async extract(job) {
        processedOffsets.push(job.fromOffset);
        if (job.fromOffset === 0) {
          throw new Error("permanent first-range failure");
        }
        return [{ target: "daily", content: "Later healthy range" }];
      },
    };
    const directory = await mkdtemp(
      join(tmpdir(), "amadeus-memory-coordinator-"),
    );
    temporaryDirectories.push(directory);
    const memoryDir = join(directory, "memory");
    const store = await MemoryStore.open({
      memoryDir,
      stateDir: join(directory, "state"),
      now: () => new Date("2026-09-04T12:00:00.000Z"),
    });
    const sessionFile = join(directory, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s4"}\n');
    await store.captureSessionRange({
      chatId: 4,
      sessionId: "s4",
      sessionFile,
    });
    await appendFile(
      sessionFile,
      '{"type":"message","message":{"role":"user","content":"later"}}\n',
    );
    await store.captureSessionRange({
      chatId: 4,
      sessionId: "s4",
      sessionFile,
    });
    const coordinator = new MemoryCoordinator({
      store,
      extractor,
      retryDelayMs: 60_000,
      now: () => 1_000,
    });

    coordinator.start();
    await waitFor(() => store.getState().memoryRevision === 1);

    expect(processedOffsets[0]).toBe(0);
    expect(processedOffsets[1]).toBeGreaterThan(0);
    expect(
      await readFile(join(memoryDir, "daily", "2026-09-04.md"), "utf8"),
    ).toContain("Later healthy range");
    await coordinator.close();
  });

  test("beginShutdown 停止 worker，但继续排空 IPC 和持久化 checkpoint", async () => {
    const fixture = await createFixture();
    const sessionFile = await writeSession(fixture.directory);

    await fixture.coordinator.beginShutdown();
    const mutation = await fixture.coordinator.handleRequest({
      kind: "tool",
      chatId: 1,
      sessionId: "s1",
      revision: 1,
      toolCallId: "during-shutdown",
      args: {
        toolName: "memory_write",
        target: "long_term",
        content: "Persist during shutdown",
      },
    });
    await fixture.coordinator.checkpointSession({
      chatId: 1,
      sessionId: "s1",
      sessionFile,
    });

    expect(mutation).toMatchObject({ status: "completed" });
    expect(fixture.extractor.jobs).toEqual([]);
    await fixture.coordinator.close();
    const reopened = await MemoryStore.open({
      memoryDir: fixture.memoryDir,
      stateDir: fixture.metadataDir,
    });
    expect(await reopened.promoteCheckpoints()).toBe(1);
  });

  test("checkpoint 返回不等待后台提取，关闭时取消 worker 并保留 job", async () => {
    const extractor = new RecordingExtractor();
    extractor.pending = new Promise(() => undefined);
    const fixture = await createFixture(extractor);
    const sessionFile = await writeSession(fixture.directory, "s3");

    const checkpointed = await Promise.race([
      fixture.coordinator
        .checkpointSession({ chatId: 3, sessionId: "s3", sessionFile })
        .then(() => true),
      Bun.sleep(50).then(() => false),
    ]);
    expect(checkpointed).toBeTrue();
    await waitFor(() => extractor.jobs.length === 1);
    await fixture.coordinator.close();

    const reopened = await MemoryStore.open({
      memoryDir: fixture.memoryDir,
      stateDir: fixture.metadataDir,
    });
    const job = await reopened.claimNextJob();
    expect(job).toMatchObject({ status: "running", attempts: 2 });
  });

  test("semantic search 交给 qmd，mutation 通知后台维护", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "amadeus-memory-coordinator-"),
    );
    temporaryDirectories.push(directory);
    const store = await MemoryStore.open({
      memoryDir: join(directory, "memory"),
      stateDir: join(directory, "state"),
    });
    const extractor = new RecordingExtractor();
    let notifications = 0;
    const searches: string[] = [];
    const coordinator = new MemoryCoordinator({
      store,
      extractor,
      qmd: {
        notifyMemoryRevision: () => {
          notifications += 1;
        },
        search: async (query, mode) => {
          searches.push(`${mode}:${query}`);
          return { content: "qmd result" };
        },
      },
    });

    await coordinator.handleRequest({
      kind: "tool",
      chatId: 1,
      sessionId: "s1",
      revision: 1,
      toolCallId: "write-qmd",
      args: {
        toolName: "memory_write",
        target: "long_term",
        content: "Uses Bun",
      },
    });
    const search = await coordinator.handleRequest({
      kind: "tool",
      chatId: 1,
      sessionId: "s1",
      revision: 1,
      toolCallId: "search-qmd",
      args: { toolName: "memory_search", query: "Bun", mode: "semantic" },
    });

    expect(notifications).toBe(1);
    expect(searches).toEqual(["semantic:Bun"]);
    expect(search).toMatchObject({
      status: "completed",
      content: "qmd result",
    });
    await coordinator.close();
  });

  test("read 与 status 不启动提取 worker", async () => {
    const fixture = await createFixture();
    const result = await fixture.coordinator.handleRequest({
      kind: "tool",
      chatId: 1,
      sessionId: "s1",
      revision: 1,
      toolCallId: "status-1",
      args: { toolName: "memory_status" },
    });

    expect(result).toMatchObject({
      status: "completed",
      content: expect.stringContaining("Memory revision"),
    });
    expect(fixture.extractor.jobs).toEqual([]);
    await fixture.coordinator.close();
  });
});

async function createFixture(
  extractor = new RecordingExtractor(),
  now: () => number = () => Date.now(),
): Promise<{
  directory: string;
  memoryDir: string;
  metadataDir: string;
  store: MemoryStore;
  extractor: RecordingExtractor;
  coordinator: MemoryCoordinator;
}> {
  const directory = await mkdtemp(
    join(tmpdir(), "amadeus-memory-coordinator-"),
  );
  temporaryDirectories.push(directory);
  const memoryDir = join(directory, "memory");
  const metadataDir = join(directory, "metadata");
  const store = await MemoryStore.open({ memoryDir, stateDir: metadataDir });
  return {
    directory,
    memoryDir,
    metadataDir,
    store,
    extractor,
    coordinator: new MemoryCoordinator({
      store,
      extractor,
      retryDelayMs: 5_000,
      now,
    }),
  };
}

async function writeSession(
  directory: string,
  sessionId = "s1",
): Promise<string> {
  const path = join(directory, "session.jsonl");
  await writeFile(
    path,
    `${JSON.stringify({ type: "session", id: sessionId })}\n{"type":"message","message":{"role":"user","content":"remember"}}\n`,
  );
  return path;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(1);
  }
  throw new Error("等待条件超时");
}
