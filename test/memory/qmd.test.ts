import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BunQmdCommandRunner,
  QmdCoordinator,
  type QmdCommandResult,
  type QmdCommandRunner,
} from "../../src/memory/qmd";
import { MemoryStore } from "../../src/memory/store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

class RecordingRunner implements QmdCommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[] }> = [];
  active = 0;
  maxActive = 0;
  failCommand: string | undefined;
  updateGate: Promise<void> | undefined;
  collectionStdout = JSON.stringify({ collections: [] });
  searchStdout = JSON.stringify([{ path: "MEMORY.md", snippet: "Uses Bun" }]);

  async run(
    command: string,
    args: readonly string[],
    _options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
  ): Promise<QmdCommandResult> {
    this.calls.push({ command, args: [...args] });
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (args[0] === this.failCommand) {
        throw new Error("qmd failed");
      }
      if (args[0] === "update" && this.updateGate) {
        await this.updateGate;
      }
      if (args[0] === "collection") {
        return {
          stdout: args[1] === "list" ? this.collectionStdout : "",
          stderr: "",
        };
      }
      if (args[0] === "vsearch" || args[0] === "query") {
        return { stdout: this.searchStdout, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    } finally {
      this.active -= 1;
    }
  }
}

describe("BunQmdCommandRunner", () => {
  test("超时使用硬终止，不等待忽略 SIGTERM 的进程", async () => {
    const runner = new BunQmdCommandRunner();
    const completed = await Promise.race([
      runner
        .run("sh", ["-c", "trap '' TERM; exec sleep 100"], {
          cwd: tmpdir(),
          timeoutMs: 10,
        })
        .then(
          () => "resolved",
          (error: unknown) =>
            error instanceof Error && error.name === "AbortError"
              ? "aborted"
              : "wrong-error",
        ),
      Bun.sleep(1_000).then(() => "timed-out"),
    ]);

    expect(completed).toBe("aborted");
  });
});

describe("QmdCoordinator", () => {
  test("单写队列自动建 collection 并追赶 update/embed watermark", async () => {
    const fixture = await createFixture();
    await fixture.store.executeMutation("write:1", {
      toolName: "memory_write",
      target: "long_term",
      content: "Uses Bun",
    });
    await fixture.store.executeMutation("write:2", {
      toolName: "memory_write",
      target: "daily",
      content: "Worked today",
    });

    fixture.qmd.start();
    await waitFor(() => fixture.store.getState().qmdEmbeddedRevision === 2);

    expect(fixture.runner.maxActive).toBe(1);
    expect(fixture.runner.calls.map((call) => call.args[0])).toEqual([
      "collection",
      "collection",
      "update",
      "embed",
    ]);
    expect(fixture.store.getState()).toMatchObject({
      memoryRevision: 2,
      qmdUpdatedRevision: 2,
      qmdEmbeddedRevision: 2,
    });
    await fixture.qmd.close();
  });

  test("已有同名 collection 必须指向当前 memoryDir", async () => {
    const correctRunner = new RecordingRunner();
    const correct = await createFixture(correctRunner);
    correctRunner.collectionStdout = JSON.stringify({
      collections: [{ name: "pi-memory", path: correct.memoryDir }],
    });
    correct.qmd.start();
    await waitFor(() =>
      correctRunner.calls.some((call) => call.args[0] === "embed"),
    );
    expect(
      correctRunner.calls.some(
        (call) => call.args[0] === "collection" && call.args[1] === "add",
      ),
    ).toBeFalse();
    await correct.qmd.close();

    const wrongRunner = new RecordingRunner();
    const wrong = await createFixture(wrongRunner);
    wrongRunner.collectionStdout = JSON.stringify({
      collections: [{ name: "pi-memory", path: "/other/memory" }],
    });
    wrong.qmd.start();
    await waitFor(() =>
      wrongRunner.calls.some(
        (call) => call.args[0] === "collection" && call.args[1] === "add",
      ),
    );
    await wrong.qmd.close();
  });

  test("写入发生在 update 期间时合并到同一后台追赶循环", async () => {
    let releaseUpdate: (() => void) | undefined;
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    const runner = new RecordingRunner();
    runner.updateGate = updateGate;
    const fixture = await createFixture(runner);
    await fixture.store.executeMutation("write:1", {
      toolName: "memory_write",
      target: "long_term",
      content: "First",
    });
    fixture.qmd.notifyMemoryRevision();
    await waitFor(() => runner.calls.some((call) => call.args[0] === "update"));

    await fixture.store.executeMutation("write:2", {
      toolName: "memory_write",
      target: "long_term",
      content: "Second",
    });
    fixture.qmd.notifyMemoryRevision();
    releaseUpdate?.();
    await waitFor(() => fixture.store.getState().qmdEmbeddedRevision === 2);

    expect(
      runner.calls.filter((call) => call.args[0] === "update"),
    ).toHaveLength(2);
    expect(
      runner.calls.filter((call) => call.args[0] === "embed"),
    ).toHaveLength(1);
    expect(runner.maxActive).toBe(1);
    await fixture.qmd.close();
  });

  test("watermark 落后时 semantic search 立即降级 keyword 并触发后台追赶", async () => {
    const fixture = await createFixture();
    await fixture.store.executeMutation("write:search", {
      toolName: "memory_write",
      target: "long_term",
      content: "Uses Bun for package management",
    });

    const result = await fixture.qmd.search("Bun", "semantic", 5);

    expect(result.content).toContain("qmd is not current");
    expect(result.content).toContain("Uses Bun");
    expect(
      fixture.runner.calls.some((call) => call.args[0] === "vsearch"),
    ).toBeFalse();
    await waitFor(() => fixture.store.getState().qmdEmbeddedRevision === 1);
    await fixture.qmd.close();
  });

  test("watermark 当前时执行 qmd search，失败则降级 keyword", async () => {
    const fixture = await createFixture();
    await fixture.store.executeMutation("write:search", {
      toolName: "memory_write",
      target: "long_term",
      content: "Uses Bun",
    });
    fixture.qmd.start();
    await waitFor(() => fixture.store.getState().qmdEmbeddedRevision === 1);

    const semantic = await fixture.qmd.search("Bun", "semantic", 5);
    expect(semantic.content).toContain("MEMORY.md\nUses Bun");

    fixture.runner.failCommand = "query";
    const deep = await fixture.qmd.search("Bun", "deep", 5);
    expect(deep.content).toContain("keyword fallback");
    expect(deep.content).toContain("Uses Bun");
    await fixture.qmd.close();
  });

  test("qmd 结果只返回受控相对路径，不泄露目录外路径", async () => {
    const fixture = await createFixture();
    await fixture.store.executeMutation("write:path", {
      toolName: "memory_write",
      target: "long_term",
      content: "Uses Bun",
    });
    fixture.qmd.start();
    await waitFor(() => fixture.store.getState().qmdEmbeddedRevision === 1);
    fixture.runner.searchStdout = JSON.stringify([
      {
        path: "/home/private/.amadeus/memory/MEMORY.md",
        snippet: "Outside path result",
      },
      {
        path: join(fixture.memoryDir, "daily", "2026-09-04.md"),
        snippet: "Inside path result",
      },
      "unexpected raw value",
    ]);

    const result = await fixture.qmd.search("result", "semantic", 5);

    expect(result.content).not.toContain("/home/private");
    expect(result.content).not.toContain("Outside path result");
    expect(result.content).toContain("daily/2026-09-04.md\nInside path result");
    expect(result.content).not.toContain("unexpected raw value");
    await fixture.qmd.close();
  });

  test("失败后的持久 watermark 允许新进程重启追赶", async () => {
    const failing = new RecordingRunner();
    failing.failCommand = "update";
    const fixture = await createFixture(failing);
    await fixture.store.executeMutation("write:restart", {
      toolName: "memory_write",
      target: "long_term",
      content: "Restart catch-up",
    });
    fixture.qmd.start();
    await waitFor(() =>
      failing.calls.some((call) => call.args[0] === "update"),
    );
    await Bun.sleep(5);
    expect(fixture.store.getState().qmdUpdatedRevision).toBe(0);
    await fixture.qmd.close();

    const runner = new RecordingRunner();
    const restarted = new QmdCoordinator({
      store: fixture.store,
      memoryDir: fixture.memoryDir,
      command: "qmd",
      enabled: true,
      searchTimeoutMs: 1_000,
      runner,
    });
    restarted.start();
    await waitFor(() => fixture.store.getState().qmdEmbeddedRevision === 1);
    expect(runner.calls.some((call) => call.args[0] === "update")).toBeTrue();
    expect(runner.calls.some((call) => call.args[0] === "embed")).toBeTrue();
    await restarted.close();
  });
});

async function createFixture(runner = new RecordingRunner()): Promise<{
  directory: string;
  memoryDir: string;
  store: MemoryStore;
  runner: RecordingRunner;
  qmd: QmdCoordinator;
}> {
  const directory = await mkdtemp(join(tmpdir(), "amadeus-memory-qmd-"));
  temporaryDirectories.push(directory);
  const memoryDir = join(directory, "memory");
  const store = await MemoryStore.open({
    memoryDir,
    stateDir: join(directory, "state"),
  });
  return {
    directory,
    memoryDir,
    store,
    runner,
    qmd: new QmdCoordinator({
      store,
      memoryDir,
      command: "qmd",
      enabled: true,
      searchTimeoutMs: 1_000,
      retryDelayMs: 60_000,
      runner,
    }),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(1);
  }
  throw new Error("等待 qmd 条件超时");
}
