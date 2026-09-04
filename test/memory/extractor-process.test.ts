import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryCoordinator } from "../../src/memory/coordinator";
import { MemoryExtractor } from "../../src/memory/extractor";
import { MemoryStore } from "../../src/memory/store";
import type { MemoryExtractionJob } from "../../src/memory/types";

const temporaryDirectories: string[] = [];
const fixtureServer = join(
  import.meta.dir,
  "..",
  "fixtures",
  "memory-pi-rpc",
  "server.ts",
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("MemoryExtractor fake Pi RPC subprocess", () => {
  test("通过真实 stdin/stdout 完成隔离提取", async () => {
    const fixture = await createFixture("success");

    await expect(fixture.extractor.extract(fixture.job)).resolves.toEqual([
      { target: "long_term", content: "From subprocess" },
    ]);
  });

  test("真实子进程超时会被取消", async () => {
    const fixture = await createFixture("hang", 20);

    await expect(fixture.extractor.extract(fixture.job)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  test("真实子进程异常退出会使提取失败", async () => {
    const fixture = await createFixture("crash");

    await expect(fixture.extractor.extract(fixture.job)).rejects.toThrow(
      "状态码 7",
    );
  });

  test("真实子进程的无效模型 JSON 会被拒绝", async () => {
    const fixture = await createFixture("invalid");

    await expect(fixture.extractor.extract(fixture.job)).rejects.toThrow(
      "valid JSON",
    );
  });

  test("异常退出后的持久任务可由新进程实例续跑", async () => {
    let now = 1_000;
    const fixture = await createFixture("crash");
    const memoryDir = join(fixture.directory, "memory");
    const stateDir = join(fixture.directory, "state");
    const store = await MemoryStore.open({ memoryDir, stateDir });
    await store.captureSessionRange({
      chatId: 1,
      sessionId: "s1",
      sessionFile: fixture.sessionFile,
    });
    const failedCoordinator = new MemoryCoordinator({
      store,
      extractor: fixture.extractor,
      retryDelayMs: 1,
      now: () => now,
    });

    expect(await failedCoordinator.processNextJob()).toBe("retry");
    await failedCoordinator.close();

    now += 1;
    const reopened = await MemoryStore.open({ memoryDir, stateDir });
    const successCommand = await createCommand(fixture.directory, "success");
    const successCoordinator = new MemoryCoordinator({
      store: reopened,
      extractor: createExtractor(
        successCommand,
        fixture.directory,
        fixture.workerSessionDir,
        1_000,
      ),
      retryDelayMs: 1,
      now: () => now,
    });

    expect(await successCoordinator.processNextJob()).toBe("processed");
    expect(await successCoordinator.processNextJob()).toBe("idle");
    expect(await readFile(join(memoryDir, "MEMORY.md"), "utf8")).toContain(
      "From subprocess",
    );
    await successCoordinator.close();
    await reopened.close();
  });
});

async function createFixture(
  mode: string,
  timeoutMs = 1_000,
): Promise<{
  directory: string;
  workerSessionDir: string;
  sessionFile: string;
  extractor: MemoryExtractor;
  job: MemoryExtractionJob;
}> {
  const directory = await mkdtemp(join(tmpdir(), "amadeus-memory-process-"));
  temporaryDirectories.push(directory);
  const workerSessionDir = join(directory, "worker-sessions");
  const sessionFile = join(directory, "session.jsonl");
  const source = [
    { type: "session", id: "s1" },
    {
      type: "message",
      message: { role: "user", content: "Remember subprocess coverage" },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n")
    .concat("\n");
  await writeFile(sessionFile, source);
  const sourceStat = await stat(sessionFile);
  const command = await createCommand(directory, mode);
  return {
    directory,
    workerSessionDir,
    sessionFile,
    extractor: createExtractor(command, directory, workerSessionDir, timeoutMs),
    job: {
      version: 1,
      chatId: 1,
      id: `extract:1:s1:${sourceStat.dev}:${sourceStat.ino}:0:${Buffer.byteLength(source)}`,
      sessionId: "s1",
      sessionFile,
      fromOffset: 0,
      toOffset: Buffer.byteLength(source),
      sourceDevice: sourceStat.dev,
      sourceInode: sourceStat.ino,
      status: "running",
      attempts: 1,
      nextAttemptAt: 0,
    },
  };
}

function createExtractor(
  command: string,
  cwd: string,
  sessionDir: string,
  timeoutMs: number,
): MemoryExtractor {
  return new MemoryExtractor({ command, cwd, sessionDir, timeoutMs });
}

async function createCommand(directory: string, mode: string): Promise<string> {
  const command = join(directory, `fake-memory-pi-${mode}`);
  await writeFile(
    command,
    `#!/usr/bin/env bash\nset -euo pipefail\nexec bun ${shellQuote(fixtureServer)} ${shellQuote(mode)} "$@"\n`,
  );
  await chmod(command, 0o755);
  return command;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
