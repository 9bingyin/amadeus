import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BunQmdCommandRunner,
  QmdCommandError,
  QmdCoordinator,
  type QmdCommandResult,
  type QmdCommandRunner,
} from "../../src/memory/qmd";
import { createInfoLogger } from "../../src/logging/logger";
import { MemoryStore } from "../../src/memory/store";
import { RecordingLogger } from "../helpers/recording-logger";

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
  searchGate: Promise<void> | undefined;
  collectionListStdout = "";
  collectionPath: string | undefined;
  collectionShowStdout: string | undefined;
  collectionShowError: QmdCommandError | undefined;
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
        throw new QmdCommandError(2, "simulated qmd failure\n");
      }
      if (args[0] === "update" && this.updateGate) {
        await this.updateGate;
      }
      if (args[0] === "collection" && args[1] === "list") {
        return { stdout: this.collectionListStdout, stderr: "" };
      }
      if (args[0] === "collection" && args[1] === "show") {
        if (this.collectionShowError) {
          throw this.collectionShowError;
        }
        if (this.collectionShowStdout !== undefined) {
          return { stdout: this.collectionShowStdout, stderr: "" };
        }
        if (this.collectionPath === undefined) {
          throw new QmdCommandError(
            1,
            `Collection not found: ${args[2] ?? ""}\n`,
          );
        }
        return {
          stdout: [
            `Collection: ${args[2] ?? ""}`,
            `  Path:     ${this.collectionPath}`,
            "  Pattern:  **/*.md",
            "  Include:  yes (default)",
          ].join("\n"),
          stderr: "",
        };
      }
      if (args[0] === "collection" && args[1] === "add") {
        this.collectionPath = args[2];
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "vsearch" || args[0] === "query") {
        if (this.searchGate) {
          await this.searchGate;
        }
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
  test("qmd 2.8.3 collection 文本输出不会阻断首次 watermark 追赶", async () => {
    const runner = new RecordingRunner();
    runner.collectionListStdout = await readFile(
      join(
        import.meta.dir,
        "..",
        "fixtures",
        "qmd-2.8.3",
        "collection-list.txt",
      ),
      "utf8",
    );
    const fixture = await createFixture(runner);
    runner.collectionShowStdout = (
      await readFile(
        join(
          import.meta.dir,
          "..",
          "fixtures",
          "qmd-2.8.3",
          "collection-show.txt",
        ),
        "utf8",
      )
    ).replace("<MEMORY_DIR>", fixture.memoryDir);
    await fixture.store.executeMutation("write:qmd-2.8.3", {
      toolName: "memory_write",
      target: "long_term",
      content: "Uses Bun",
    });

    fixture.qmd.start();
    await waitFor(() => fixture.store.getState().qmdEmbeddedRevision === 1);

    expect(fixture.store.getState()).toMatchObject({
      memoryRevision: 1,
      qmdUpdatedRevision: 1,
      qmdEmbeddedRevision: 1,
    });
    expect(
      runner.calls.some(
        (call) => call.args[0] === "collection" && call.args[1] === "list",
      ),
    ).toBeFalse();
    expect(
      runner.calls.some(
        (call) => call.args[0] === "collection" && call.args[1] === "show",
      ),
    ).toBeTrue();
    await fixture.qmd.close();
  });

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
    expect(fixture.runner.calls.map((call) => call.args.slice(0, 2))).toEqual([
      ["collection", "show"],
      ["collection", "add"],
      ["collection", "show"],
      ["update"],
      ["embed"],
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
    correctRunner.collectionPath = `${correct.memoryDir}/`;
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
    wrongRunner.collectionPath = wrong.directory;
    wrong.qmd.start();
    await waitFor(() =>
      wrongRunner.calls.some(
        (call) => call.args[0] === "collection" && call.args[1] === "show",
      ),
    );
    await Bun.sleep(5);
    expect(
      wrongRunner.calls.some(
        (call) => call.args[0] === "collection" && call.args[1] === "add",
      ),
    ).toBeFalse();
    expect(
      wrongRunner.calls.some(
        (call) => call.args[0] === "update" || call.args[0] === "embed",
      ),
    ).toBeFalse();
    expect(
      wrong.logger.entries.find(
        (entry) => entry.event === "memory_qmd_maintenance_failed",
      ),
    ).toEqual({
      event: "memory_qmd_maintenance_failed",
      fields: {
        operation: "collection_check",
        error_name: "QmdCollectionPathMismatchError",
        reason: "collection_path_mismatch",
        retry_delay_ms: 60_000,
      },
    });
    await wrong.qmd.close();
  });

  test("collection show 路径按相对路径和符号链接 canonicalize", async () => {
    const relativeRunner = new RecordingRunner();
    const relative = await createFixture(relativeRunner);
    relativeRunner.collectionPath = ".";
    relative.qmd.start();
    await waitFor(() =>
      relativeRunner.calls.some((call) => call.args[0] === "embed"),
    );
    await relative.qmd.close();

    const symlinkRunner = new RecordingRunner();
    const linked = await createFixture(symlinkRunner);
    const linkedPath = join(linked.directory, "memory-link");
    await symlink(linked.memoryDir, linkedPath, "dir");
    symlinkRunner.collectionPath = linkedPath;
    linked.qmd.start();
    await waitFor(() =>
      symlinkRunner.calls.some((call) => call.args[0] === "embed"),
    );
    expect(
      symlinkRunner.calls.some(
        (call) => call.args[0] === "collection" && call.args[1] === "add",
      ),
    ).toBeFalse();
    await linked.qmd.close();
  });

  test("collection show 的普通命令失败不会被当作 collection 不存在", async () => {
    const runner = new RecordingRunner();
    runner.failCommand = "collection";
    const fixture = await createFixture(runner);

    fixture.qmd.start();
    await waitFor(() =>
      fixture.logger.events().includes("memory_qmd_maintenance_failed"),
    );

    expect(
      runner.calls.some(
        (call) => call.args[0] === "collection" && call.args[1] === "add",
      ),
    ).toBeFalse();
    expect(
      fixture.logger.entries.find(
        (entry) => entry.event === "memory_qmd_maintenance_failed",
      ),
    ).toEqual({
      event: "memory_qmd_maintenance_failed",
      fields: {
        operation: "collection_check",
        error_name: "QmdCommandError",
        reason: "command_failed",
        retry_delay_ms: 60_000,
        exit_code: 2,
      },
    });
    await fixture.qmd.close();
  });

  test("status 1 含额外错误或其他名称时不会误判为不存在", async () => {
    for (const stderr of [
      "Database is unavailable\nCollection not found: pi-memory\n",
      "Collection not found: other-memory\n",
    ]) {
      const runner = new RecordingRunner();
      runner.collectionShowError = new QmdCommandError(1, stderr);
      const fixture = await createFixture(runner);

      fixture.qmd.start();
      await waitFor(() =>
        fixture.logger.events().includes("memory_qmd_maintenance_failed"),
      );

      expect(
        runner.calls.some(
          (call) => call.args[0] === "collection" && call.args[1] === "add",
        ),
      ).toBeFalse();
      expect(
        fixture.logger.entries.find(
          (entry) => entry.event === "memory_qmd_maintenance_failed",
        ),
      ).toEqual({
        event: "memory_qmd_maintenance_failed",
        fields: {
          operation: "collection_check",
          error_name: "QmdCommandError",
          reason: "command_failed",
          retry_delay_ms: 60_000,
          exit_code: 1,
        },
      });
      await fixture.qmd.close();
    }
  });

  test("维护日志不输出 qmd stderr 中的路径、Token 或正文", async () => {
    const runner = new RecordingRunner();
    runner.collectionShowError = new QmdCommandError(
      2,
      "SQLite failed at /private/memory.db token=secret private body\n",
    );
    const fixture = await createFixture(runner);
    const lines: string[] = [];
    const qmd = new QmdCoordinator({
      store: fixture.store,
      memoryDir: fixture.memoryDir,
      command: "qmd",
      enabled: true,
      searchTimeoutMs: 1_000,
      retryDelayMs: 60_000,
      runner,
      logger: createInfoLogger({
        now: () => new Date("2026-09-04T00:00:00.000Z"),
        writeLine: (line) => lines.push(line),
      }),
    });

    qmd.start();
    await waitFor(() => lines.length === 1);

    expect(lines[0]).toContain("event=memory_qmd_maintenance_failed");
    expect(lines[0]).toContain('operation="collection_check"');
    expect(lines[0]).toContain('reason="command_failed"');
    expect(lines[0]).not.toContain("/private");
    expect(lines[0]).not.toContain("secret");
    expect(lines[0]).not.toContain("private body");
    await qmd.close();
  });

  test("维护失败限频记录并在恢复后记录一次", async () => {
    const runner = new RecordingRunner();
    runner.collectionShowStdout = "unexpected collection output\n";
    const fixture = await createFixture(runner, 10);

    fixture.qmd.start();
    await waitFor(
      () =>
        fixture.logger
          .events()
          .filter((event) => event === "memory_qmd_maintenance_failed")
          .length === 1,
    );
    await waitFor(
      () =>
        runner.calls.filter(
          (call) => call.args[0] === "collection" && call.args[1] === "show",
        ).length >= 2,
    );
    expect(
      fixture.logger.entries.filter(
        (entry) => entry.event === "memory_qmd_maintenance_failed",
      ),
    ).toEqual([
      {
        event: "memory_qmd_maintenance_failed",
        fields: {
          operation: "collection_check",
          error_name: "QmdCollectionOutputError",
          reason: "collection_output_invalid",
          retry_delay_ms: 10,
        },
      },
    ]);

    runner.collectionShowStdout = [
      "Collection: pi-memory",
      `  Path:     ${fixture.memoryDir}`,
      "  Pattern:  **/*.md",
      "  Include:  yes (default)",
    ].join("\n");
    await waitFor(() =>
      fixture.logger.events().includes("memory_qmd_maintenance_recovered"),
    );
    expect(
      fixture.logger.entries.filter(
        (entry) => entry.event === "memory_qmd_maintenance_recovered",
      ),
    ).toEqual([
      {
        event: "memory_qmd_maintenance_recovered",
        fields: { previous_operation: "collection_check" },
      },
    ]);
    await fixture.qmd.close();
  });

  test("embed 失败保留 update watermark，重试时不重复 update", async () => {
    const runner = new RecordingRunner();
    const fixture = await createFixture(runner, 10);
    runner.collectionPath = fixture.memoryDir;
    runner.failCommand = "embed";
    await fixture.store.executeMutation("write:embed-retry", {
      toolName: "memory_write",
      target: "long_term",
      content: "Retry embedding",
    });

    fixture.qmd.start();
    await waitFor(() =>
      fixture.logger.events().includes("memory_qmd_maintenance_failed"),
    );
    expect(fixture.store.getState()).toMatchObject({
      memoryRevision: 1,
      qmdUpdatedRevision: 1,
      qmdEmbeddedRevision: 0,
    });
    expect(
      runner.calls.filter((call) => call.args[0] === "update"),
    ).toHaveLength(1);
    expect(
      fixture.logger.entries.find(
        (entry) => entry.event === "memory_qmd_maintenance_failed",
      ),
    ).toEqual({
      event: "memory_qmd_maintenance_failed",
      fields: {
        operation: "embed",
        error_name: "QmdCommandError",
        reason: "command_failed",
        retry_delay_ms: 10,
        exit_code: 2,
      },
    });

    runner.failCommand = undefined;
    await waitFor(() => fixture.store.getState().qmdEmbeddedRevision === 1);
    expect(
      runner.calls.filter((call) => call.args[0] === "update"),
    ).toHaveLength(1);
    await waitFor(() =>
      fixture.logger.events().includes("memory_qmd_maintenance_recovered"),
    );
    expect(
      fixture.logger.entries.filter(
        (entry) => entry.event === "memory_qmd_maintenance_recovered",
      ),
    ).toEqual([
      {
        event: "memory_qmd_maintenance_recovered",
        fields: { previous_operation: "embed" },
      },
    ]);
    await fixture.qmd.close();
  });

  test("启动刷新 embed 失败时搜索降级且重试不重复 update", async () => {
    const runner = new RecordingRunner();
    const fixture = await createFixture(runner, 10);
    runner.collectionPath = fixture.memoryDir;
    await fixture.store.executeMutation("write:startup-refresh", {
      toolName: "memory_write",
      target: "long_term",
      content: "Startup refresh",
    });
    await fixture.store.updateQmdWatermarks({
      updatedRevision: 1,
      embeddedRevision: 1,
    });
    runner.failCommand = "embed";

    fixture.qmd.start();
    await waitFor(() =>
      fixture.logger.events().includes("memory_qmd_maintenance_failed"),
    );
    expect(
      runner.calls.filter((call) => call.args[0] === "update"),
    ).toHaveLength(1);

    const degraded = await fixture.qmd.search("Startup", "semantic", 5);
    expect(degraded.content).toContain("keyword fallback");
    expect(runner.calls.some((call) => call.args[0] === "vsearch")).toBeFalse();

    runner.failCommand = undefined;
    await waitFor(() =>
      fixture.logger.events().includes("memory_qmd_maintenance_recovered"),
    );
    expect(
      runner.calls.filter((call) => call.args[0] === "update"),
    ).toHaveLength(1);
    expect(fixture.store.getState()).toMatchObject({
      memoryRevision: 1,
      qmdUpdatedRevision: 1,
      qmdEmbeddedRevision: 1,
    });
    await fixture.qmd.close();
  });

  test("关闭前排队的维护不会误报 recovered", async () => {
    const runner = new RecordingRunner();
    runner.failCommand = "collection";
    const fixture = await createFixture(runner);
    fixture.qmd.start();
    await waitFor(() =>
      fixture.logger.events().includes("memory_qmd_maintenance_failed"),
    );

    fixture.qmd.notifyMemoryRevision();
    await fixture.qmd.close();

    expect(
      fixture.logger.events().includes("memory_qmd_maintenance_recovered"),
    ).toBeFalse();
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

  test("排队中的 qmd search 被取消后不会迟到启动", async () => {
    const fixture = await createFixture();
    await fixture.store.executeMutation("write:queued-search", {
      toolName: "memory_write",
      target: "long_term",
      content: "Uses Bun",
    });
    fixture.qmd.start();
    await waitFor(() => fixture.store.getState().qmdEmbeddedRevision === 1);

    let releaseSearch: (() => void) | undefined;
    fixture.runner.searchGate = new Promise<void>((resolve) => {
      releaseSearch = resolve;
    });
    const firstSearch = fixture.qmd.search("first", "semantic", 5);
    await waitFor(() => fixture.runner.active === 1);

    const controller = new AbortController();
    const search = fixture.qmd.search("Bun", "semantic", 5, controller.signal);
    controller.abort();
    await expect(search).rejects.toHaveProperty("name", "AbortError");
    releaseSearch?.();
    await firstSearch;
    await waitFor(() => fixture.runner.active === 0);
    expect(
      fixture.runner.calls.filter((call) => call.args[0] === "vsearch"),
    ).toHaveLength(1);
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

async function createFixture(
  runner = new RecordingRunner(),
  retryDelayMs = 60_000,
): Promise<{
  directory: string;
  memoryDir: string;
  store: MemoryStore;
  runner: RecordingRunner;
  logger: RecordingLogger;
  qmd: QmdCoordinator;
}> {
  const directory = await mkdtemp(join(tmpdir(), "amadeus-memory-qmd-"));
  temporaryDirectories.push(directory);
  const memoryDir = join(directory, "memory");
  const store = await MemoryStore.open({
    memoryDir,
    stateDir: join(directory, "state"),
  });
  const logger = new RecordingLogger();
  return {
    directory,
    memoryDir,
    store,
    runner,
    logger,
    qmd: new QmdCoordinator({
      store,
      memoryDir,
      command: "qmd",
      enabled: true,
      searchTimeoutMs: 1_000,
      retryDelayMs,
      runner,
      logger,
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
