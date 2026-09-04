import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/memory/store";

const temporaryDirectories: string[] = [];

const NOW = new Date("2026-09-04T12:34:56.000Z");
const RECOVERY_ID = "12345678-1234-4123-8123-123456789abc";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("MemoryStore", () => {
  test("初始化兼容 Markdown 布局并提供稳定快照", async () => {
    const fixture = await createStore();

    expect(await readFile(join(fixture.memoryDir, "MEMORY.md"), "utf8")).toBe(
      "",
    );
    expect(
      await readFile(join(fixture.memoryDir, "SCRATCHPAD.md"), "utf8"),
    ).toBe("# Scratchpad\n");
    expect(await readdir(join(fixture.memoryDir, "daily"))).toEqual([]);
    expect(await readdir(join(fixture.memoryDir, "recovery"))).toEqual([]);
    expect(fixture.store.getSnapshot()).toEqual({ revision: 0, content: "" });
  });

  test("已有兼容 Markdown 在首次启用时建立非零 revision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-memory-store-"));
    temporaryDirectories.push(directory);
    const memoryDir = join(directory, "memory");
    await mkdir(memoryDir, { recursive: true });
    await writeFile(join(memoryDir, "MEMORY.md"), "Existing memory\n");

    const store = await MemoryStore.open({
      memoryDir,
      stateDir: join(directory, "state"),
    });

    expect(store.getState().memoryRevision).toBe(1);
    expect(store.getSnapshot().content).toContain("Existing memory");
  });

  test("启动时完成崩溃前已持久化的 prepared receipt", async () => {
    const fixture = await createStore();
    const receiptId = "session:prepared";
    const receiptName = `${createHash("sha256").update(receiptId).digest("hex")}.json`;
    await writeFile(
      join(fixture.metadataDir, "receipts", receiptName),
      JSON.stringify({
        version: 1,
        status: "prepared",
        receiptId,
        revision: 1,
        writes: [
          {
            relativePath: "MEMORY.md",
            content:
              "<!-- 2026-09-04 12:34:56 [amadeus] -->\n<!-- amadeus-memory:session:prepared -->\nRecovered write\n",
          },
        ],
        result: { content: "Stored." },
      }),
    );

    const recovered = await MemoryStore.open(fixture.options);

    expect(
      await readFile(join(fixture.memoryDir, "MEMORY.md"), "utf8"),
    ).toContain("Recovered write");
    expect(recovered.getState().memoryRevision).toBe(1);
    const receipt = JSON.parse(
      await readFile(
        join(fixture.metadataDir, "receipts", receiptName),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(receipt.status).toBe("completed");
  });

  test("拒绝受管目录符号链接逃逸", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-memory-store-"));
    temporaryDirectories.push(directory);
    const memoryDir = join(directory, "memory");
    const outside = join(directory, "outside");
    await mkdir(memoryDir, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(memoryDir, "daily"));

    await expect(
      MemoryStore.open({ memoryDir, stateDir: join(directory, "state") }),
    ).rejects.toThrow("symbolic links");
  });

  test("写入前重新拒绝被替换为符号链接的受管目录", async () => {
    const fixture = await createStore();
    const outside = join(fixture.directory, "outside");
    await mkdir(outside, { recursive: true });
    await rm(join(fixture.memoryDir, "daily"), { recursive: true });
    await symlink(outside, join(fixture.memoryDir, "daily"));

    await expect(
      fixture.store.executeMutation("daily:escape", {
        toolName: "memory_write",
        target: "daily",
        content: "must stay inside",
      }),
    ).rejects.toThrow("escapes");
    expect(await readdir(outside)).toEqual([]);
  });

  test("并发 mutation 串行提交并通过 receipt 和隐藏标记幂等", async () => {
    const fixture = await createStore();

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        fixture.store.executeMutation(`session:call-${index}`, {
          toolName: "memory_write",
          target: "long_term",
          content: `Fact ${index}`,
        }),
      ),
    );
    await fixture.store.executeMutation("session:call-3", {
      toolName: "memory_write",
      target: "long_term",
      content: "Fact 3",
    });

    const content = await readFile(
      join(fixture.memoryDir, "MEMORY.md"),
      "utf8",
    );
    expect(
      content.match(/<!-- amadeus-memory:session:call-3 -->/g),
    ).toHaveLength(1);
    for (let index = 0; index < 8; index += 1) {
      expect(content).toContain(`Fact ${index}`);
    }
    expect(fixture.store.getState().memoryRevision).toBe(8);
    expect(fixture.store.getSnapshot().content).toContain("### MEMORY.md");

    const reopened = await MemoryStore.open(fixture.options);
    expect(reopened.getState().memoryRevision).toBe(8);
    expect(reopened.getSnapshot()).toEqual(fixture.store.getSnapshot());
  });

  test("scratchpad 保留手写内容并支持 add、done、undo 和 clear_done", async () => {
    const fixture = await createStore();
    await writeFile(
      join(fixture.memoryDir, "SCRATCHPAD.md"),
      "# Scratchpad\n\nHandwritten note\n",
    );

    await fixture.store.executeMutation("scratch:add", {
      toolName: "scratchpad",
      action: "add",
      text: "fix parser",
    });
    await fixture.store.executeMutation("scratch:done", {
      toolName: "scratchpad",
      action: "done",
      text: "parser",
    });
    expect(
      (await fixture.store.read({ toolName: "scratchpad", action: "list" }))
        .content,
    ).toContain("- [x] fix parser");
    await fixture.store.executeMutation("scratch:undo", {
      toolName: "scratchpad",
      action: "undo",
      text: "parser",
    });
    await fixture.store.executeMutation("scratch:done-2", {
      toolName: "scratchpad",
      action: "done",
      text: "parser",
    });
    await fixture.store.executeMutation("scratch:clear", {
      toolName: "scratchpad",
      action: "clear_done",
    });

    const content = await readFile(
      join(fixture.memoryDir, "SCRATCHPAD.md"),
      "utf8",
    );
    expect(content).toContain("Handwritten note");
    expect(content).not.toContain("fix parser");
  });

  test("forget 对旧版无标记段落只删除匹配段落", async () => {
    const fixture = await createStore();
    await writeFile(
      join(fixture.memoryDir, "MEMORY.md"),
      "Keep legacy paragraph.\n\nRemove legacy secret.\n",
    );

    await fixture.store.executeMutation("forget:legacy", {
      toolName: "memory_forget",
      match: "secret",
    });

    const content = await readFile(
      join(fixture.memoryDir, "MEMORY.md"),
      "utf8",
    );
    expect(content).toContain("Keep legacy paragraph.");
    expect(content).not.toContain("Remove legacy secret.");
  });

  test("forget 生成兼容 recovery 记录且 restore 只恢复一次", async () => {
    const fixture = await createStore();
    await fixture.store.executeMutation("write:keep", {
      toolName: "memory_write",
      target: "long_term",
      content: "Keep this fact",
    });
    await fixture.store.executeMutation("write:remove", {
      toolName: "memory_write",
      target: "long_term",
      content: "Remove this secret",
    });

    const forgotten = await fixture.store.executeMutation("forget:1", {
      toolName: "memory_forget",
      match: "secret",
    });
    expect(forgotten.content).toContain(`Recovery ID: ${RECOVERY_ID}`);
    const afterForget = await readFile(
      join(fixture.memoryDir, "MEMORY.md"),
      "utf8",
    );
    expect(afterForget).toContain("Keep this fact");
    expect(afterForget).not.toContain("Remove this secret");

    const recovery = JSON.parse(
      await readFile(
        join(fixture.memoryDir, "recovery", `${RECOVERY_ID}.json`),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(recovery).toMatchObject({
      version: 1,
      id: RECOVERY_ID,
      target: "long_term",
    });
    expect(Array.isArray(recovery.removedContent)).toBeTrue();

    await fixture.store.executeMutation("restore:1", {
      toolName: "memory_restore",
      recoveryId: RECOVERY_ID,
    });
    await fixture.store.executeMutation("restore:1", {
      toolName: "memory_restore",
      recoveryId: RECOVERY_ID,
    });
    const restored = await readFile(
      join(fixture.memoryDir, "MEMORY.md"),
      "utf8",
    );
    expect(restored.match(/Remove this secret/g)).toHaveLength(1);
  });

  test("checkpoint 只接受完整 LF JSONL 边界并保存增量范围", async () => {
    let currentTime = new Date("2026-09-04T23:59:00.000Z");
    const fixture = await createStore(() => new Date(currentTime));
    const sessionFile = join(fixture.directory, "session.jsonl");
    await writeFile(
      sessionFile,
      '{"type":"session","id":"s1","timestamp":"2026-09-03T20:00:00.000Z"}\n',
    );

    const first = await fixture.store.captureSessionRange({
      chatId: 7,
      sessionId: "s1",
      sessionFile,
    });
    expect(first).toMatchObject({ fromOffset: 0 });
    await appendFile(sessionFile, '{"type":"message","role":"user"}\n');
    currentTime = new Date("2026-09-05T00:01:00.000Z");
    const second = await fixture.store.captureSessionRange({
      chatId: 7,
      sessionId: "s1",
      sessionFile,
    });
    expect(second?.fromOffset).toBe(first?.toOffset);
    expect(first?.capturedAt).toBe(Date.parse("2026-09-03T20:00:00.000Z"));
    expect(second?.capturedAt).toBe(first?.capturedAt);

    await appendFile(sessionFile, '{"incomplete":true}');
    await expect(
      fixture.store.captureSessionRange({
        chatId: 7,
        sessionId: "s1",
        sessionFile,
      }),
    ).rejects.toThrow("LF boundary");

    const crlfFile = join(fixture.directory, "crlf.jsonl");
    await writeFile(
      crlfFile,
      '{"type":"session","id":"s2"}\n{"type":"message"}\r\n',
    );
    await expect(
      fixture.store.captureSessionRange({
        chatId: 8,
        sessionId: "s2",
        sessionFile: crlfFile,
      }),
    ).rejects.toThrow("strict LF boundary");
  });

  test("较长 session 按提取预算拆成多个任务", async () => {
    const fixture = await createStore();
    const sessionFile = join(fixture.directory, "split-jobs.jsonl");
    const lines = Array.from({ length: 400 }, (_, index) =>
      JSON.stringify({
        type: "message",
        message: { role: "user", content: `${index}:${"x".repeat(3_000)}` },
      }),
    );
    await writeFile(
      sessionFile,
      `{"type":"session","id":"split-jobs"}\n${lines.join("\n")}\n`,
    );

    await fixture.store.captureSessionRange({
      chatId: 8,
      sessionId: "split-jobs",
      sessionFile,
    });
    expect(await fixture.store.promoteCheckpoints()).toBeGreaterThan(1);

    const first = await fixture.store.claimNextJob();
    const second = await fixture.store.claimNextJob();
    expect(first?.sessionId).toBe("split-jobs");
    expect(second?.sessionId).toBe("split-jobs");
    expect(first?.toOffset).toBe(second?.fromOffset);
  });

  test("checkpoint 绑定文件身份并由后台生成稳定范围", async () => {
    const fixture = await createStore();
    const sessionFile = join(fixture.directory, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const first = await fixture.store.captureSessionRange({
      chatId: 9,
      sessionId: "s1",
      sessionFile,
    });

    const replacement = join(fixture.directory, "replacement.jsonl");
    const largeLine = `${JSON.stringify({
      type: "message",
      message: { role: "user", content: "x".repeat(140_000) },
    })}\n`;
    await writeFile(
      replacement,
      `{"type":"session","id":"s1"}\n${largeLine}${largeLine}${largeLine}`,
    );
    await rename(replacement, sessionFile);
    const replaced = await fixture.store.captureSessionRange({
      chatId: 9,
      sessionId: "s1",
      sessionFile,
    });

    expect(replaced?.fromOffset).toBe(0);
    expect(replaced?.id).not.toBe(first?.id);
    const checkpointFiles = await readdir(
      join(fixture.metadataDir, "checkpoints"),
    );
    const checkpoint: unknown = JSON.parse(
      await readFile(
        join(fixture.metadataDir, "checkpoints", checkpointFiles[0] ?? ""),
        "utf8",
      ),
    );
    if (
      typeof checkpoint !== "object" ||
      checkpoint === null ||
      !("pendingHead" in checkpoint) ||
      typeof checkpoint.pendingHead !== "string"
    ) {
      throw new Error("预期 checkpoint pendingHead");
    }
    expect("pending" in checkpoint).toBeFalse();
    expect(
      await readdir(join(fixture.metadataDir, "checkpoints", "ranges")),
    ).toHaveLength(2);
    expect(await fixture.store.promoteCheckpoints()).toBeGreaterThanOrEqual(2);
    const promotedCheckpoint: unknown = JSON.parse(
      await readFile(
        join(fixture.metadataDir, "checkpoints", checkpointFiles[0] ?? ""),
        "utf8",
      ),
    );
    expect(promotedCheckpoint).not.toHaveProperty("pendingHead");
    expect(
      await readdir(join(fixture.metadataDir, "checkpoints", "ranges")),
    ).toHaveLength(0);

    const wrongHeader = join(fixture.directory, "wrong.jsonl");
    await writeFile(wrongHeader, '{"type":"session","id":"other"}\n');
    await expect(
      fixture.store.captureSessionRange({
        chatId: 10,
        sessionId: "s1",
        sessionFile: wrongHeader,
      }),
    ).rejects.toThrow("does not match");
  });

  test("旧 pending 数组在启动时迁移为固定大小链式 checkpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-memory-store-"));
    temporaryDirectories.push(directory);
    const memoryDir = join(directory, "memory");
    const stateDir = join(directory, "state");
    const checkpointsDir = join(stateDir, "checkpoints");
    await mkdir(checkpointsDir, { recursive: true });
    const sessionFile = join(directory, "legacy-session.jsonl");
    const source = '{"type":"session","id":"legacy"}\n';
    await writeFile(sessionFile, source);
    const sourceStat = await stat(sessionFile);
    const range = {
      id: `extract:11:legacy:${sourceStat.dev}:${sourceStat.ino}:0:${Buffer.byteLength(source)}`,
      sessionId: "legacy",
      sessionFile,
      fromOffset: 0,
      toOffset: Buffer.byteLength(source),
      sourceDevice: sourceStat.dev,
      sourceInode: sourceStat.ino,
    };
    const checkpointPath = join(
      checkpointsDir,
      `${createHash("sha256").update("11").digest("hex")}.json`,
    );
    await writeFile(
      checkpointPath,
      `${JSON.stringify({ version: 1, chatId: 11, pending: [range] })}\n`,
    );

    const store = await MemoryStore.open({ memoryDir, stateDir });
    const migrated: unknown = JSON.parse(
      await readFile(checkpointPath, "utf8"),
    );
    expect(migrated).toMatchObject({ version: 1, chatId: 11 });
    expect(migrated).toHaveProperty("pendingHead", range.id);
    expect(migrated).not.toHaveProperty("pending");
    expect(await store.promoteCheckpoints()).toBe(1);
  });

  test("自动 daily 提取使用每 session 一块的结构化摘要", async () => {
    const fixture = await createStore();
    const sessionFile = join(fixture.directory, "summary-session.jsonl");
    await writeFile(
      sessionFile,
      '{"type":"session","id":"summary-session"}\n{"type":"message","message":{"role":"user","content":"investigate"}}\n',
    );
    await fixture.store.captureSessionRange({
      chatId: 12,
      sessionId: "summary-session",
      sessionFile,
    });
    const job = await fixture.store.claimNextJob();
    if (!job) {
      throw new Error("预期提取任务");
    }
    await fixture.store.completeExtractionJob(job, [
      {
        target: "daily",
        decisions: [],
        lessonsLearned: [],
        notes: ["调查结果值得保留。"],
        followUps: [],
      },
    ]);

    const dailyPath = join(fixture.memoryDir, "daily", "2026-09-04.md");
    const firstDaily = await readFile(dailyPath, "utf8");
    await writeFile(
      dailyPath,
      `<!-- source-session: summary-session -->\n<!-- 2026-09-04 10:00:00 [legacy] -->\n## Session Summary (backfill)\n\n### Notes\n- 旧摘要必须保留。\n\n${firstDaily}`,
    );
    await fixture.store.completeExtractionJob(
      { ...job, id: `${job.id}:next`, fromOffset: job.toOffset },
      [
        {
          target: "daily",
          decisions: ["采用结构化摘要。"],
          lessonsLearned: [],
          notes: [],
          followUps: [],
        },
      ],
    );

    const daily = await readFile(dailyPath, "utf8");
    expect(daily).toContain("<!-- source-session: summary-session -->");
    expect(daily).toContain("## Session Summary (backfill)");
    expect(daily.match(/## Session Summary \(auto\)/g)).toHaveLength(1);
    expect(daily).toContain("### Decisions\n- 采用结构化摘要。");
    expect(daily).toContain("### Notes\n- 调查结果值得保留。");
    expect(daily).not.toContain(job.id);
    expect(await readdir(join(fixture.memoryDir, "daily"))).toEqual([
      "2026-09-04.md",
    ]);

    await appendFile(dailyPath, "\n这段手写内容必须保留。\n");
    await fixture.store.executeMutation("forget:auto-summary", {
      toolName: "memory_forget",
      target: "daily",
      date: "2026-09-04",
      match: "调查结果值得保留",
    });
    const forgotten = await readFile(dailyPath, "utf8");
    expect(forgotten).toContain("## Session Summary (backfill)");
    expect(forgotten).not.toContain("## Session Summary (auto)");
    expect(forgotten).toContain("这段手写内容必须保留。");
    expect(forgotten.match(/source-session: summary-session/g)).toHaveLength(1);
  });

  test("自动摘要被手工修改后拒绝静默重写未知内容", async () => {
    const fixture = await createStore();
    const sessionFile = join(fixture.directory, "edited-summary.jsonl");
    await writeFile(
      sessionFile,
      '{"type":"session","id":"edited-summary"}\n{"type":"message","message":{"role":"user","content":"test"}}\n',
    );
    await fixture.store.captureSessionRange({
      chatId: 13,
      sessionId: "edited-summary",
      sessionFile,
    });
    const job = await fixture.store.claimNextJob();
    if (!job) {
      throw new Error("预期提取任务");
    }
    const entry = {
      target: "daily" as const,
      decisions: [],
      lessonsLearned: [],
      notes: ["原始摘要。"],
      followUps: [],
    };
    await fixture.store.completeExtractionJob(job, [entry]);
    const dailyPath = join(fixture.memoryDir, "daily", "2026-09-04.md");
    const original = await readFile(dailyPath, "utf8");
    const edited = original.replace(
      /<!-- amadeus-summary-end:/,
      "这段手写内容不能被删除。\n\n<!-- amadeus-summary-end:",
    );
    await writeFile(dailyPath, edited);

    await expect(
      fixture.store.completeExtractionJob(
        { ...job, id: `${job.id}:next`, fromOffset: job.toOffset },
        [entry],
      ),
    ).rejects.toThrow("Existing extracted daily summary is invalid");
    expect(await readFile(dailyPath, "utf8")).toBe(edited);
  });

  test("pending checkpoint、running job 和幂等提取提交可跨重启恢复", async () => {
    const fixture = await createStore();
    const sessionFile = join(fixture.directory, "session.jsonl");
    await writeFile(
      sessionFile,
      '{"type":"session","id":"s1"}\n{"type":"message","role":"user"}\n',
    );
    await fixture.store.captureSessionRange({
      chatId: 8,
      sessionId: "s1",
      sessionFile,
    });

    const reopened = await MemoryStore.open(fixture.options);
    expect(await reopened.promoteCheckpoints()).toBe(1);
    const firstClaim = await reopened.claimNextJob();
    expect(firstClaim).toMatchObject({ status: "running", attempts: 1 });
    if (!firstClaim) {
      throw new Error("预期提取任务");
    }

    const recovered = await MemoryStore.open(fixture.options);
    const secondClaim = await recovered.claimNextJob();
    expect(secondClaim).toMatchObject({
      id: firstClaim.id,
      status: "running",
      attempts: 2,
    });
    if (!secondClaim) {
      throw new Error("预期恢复后的提取任务");
    }
    await recovered.completeExtractionJob(secondClaim, [
      { target: "long_term", content: "#preference Uses Bun" },
      {
        target: "daily",
        decisions: [],
        lessonsLearned: [],
        notes: ["Worked on memory"],
        followUps: [],
      },
    ]);
    await recovered.completeExtractionJob(secondClaim, [
      { target: "long_term", content: "Changed retry output" },
      {
        target: "daily",
        decisions: [],
        lessonsLearned: [],
        notes: ["Unexpected retry item"],
        followUps: [],
      },
      { target: "long_term", content: "Unexpected extra item" },
    ]);

    expect(await recovered.claimNextJob()).toBeNull();
    expect(
      (await readFile(join(fixture.memoryDir, "MEMORY.md"), "utf8")).match(
        /#preference Uses Bun/g,
      ),
    ).toHaveLength(1);
    const longTerm = await readFile(
      join(fixture.memoryDir, "MEMORY.md"),
      "utf8",
    );
    expect(longTerm).not.toContain("Changed retry output");
    expect(longTerm).not.toContain("Unexpected extra item");
    const daily = await readFile(
      join(fixture.memoryDir, "daily", "2026-09-04.md"),
      "utf8",
    );
    expect(daily).toContain("Worked on memory");
    expect(daily).not.toContain("Unexpected retry item");
  });
});

async function createStore(now: () => Date = () => new Date(NOW)): Promise<{
  directory: string;
  memoryDir: string;
  metadataDir: string;
  options: {
    memoryDir: string;
    stateDir: string;
    now: () => Date;
    createId: () => string;
  };
  store: MemoryStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), "amadeus-memory-store-"));
  temporaryDirectories.push(directory);
  const memoryDir = join(directory, "memory");
  const metadataDir = join(directory, "state");
  const options = {
    memoryDir,
    stateDir: metadataDir,
    now,
    createId: () => RECOVERY_ID,
  };
  return {
    directory,
    memoryDir,
    metadataDir,
    options,
    store: await MemoryStore.open(options),
  };
}
