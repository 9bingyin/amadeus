import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../../src/config";
import { MemoryRuntime } from "../../src/memory/runtime";
import { RecordingLogger } from "../helpers/recording-logger";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("MemoryRuntime", () => {
  test("关闭配置时不创建运行时", async () => {
    const config = await createConfig(false);
    expect(
      await MemoryRuntime.create(config, new RecordingLogger()),
    ).toBeUndefined();
  });

  test("接入 store、IPC 和关闭生命周期且不自动加载插件", async () => {
    const config = await createConfig(true);
    const runtime = await MemoryRuntime.create(config, new RecordingLogger());
    if (!runtime) {
      throw new Error("预期 memory runtime");
    }

    const result = await runtime.handleRequest({
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
    expect(result).toMatchObject({ status: "completed" });
    expect(
      await readFile(join(config.paths.memoryDir, "MEMORY.md"), "utf8"),
    ).toContain("Uses Bun");

    await runtime.close({ version: 1, chats: {} });
    expect(config.pi.args).toEqual([]);
  });
});

async function createConfig(enabled: boolean): Promise<AppConfig> {
  const directory = await mkdtemp(join(tmpdir(), "amadeus-memory-runtime-"));
  temporaryDirectories.push(directory);
  return {
    stt: { enabled: false },
    telegram: {
      botToken: "token",
      allowedUserIds: [1],
      streamResponses: false,
    },
    pi: { command: "pi", args: [] },
    memory: {
      enabled,
      extractionTimeoutMs: 100,
      qmd: { enabled: false, command: "qmd", searchTimeoutMs: 100 },
    },
    paths: {
      stateDir: join(directory, "state"),
      sessionDir: join(directory, "sessions"),
      attachmentsDir: join(directory, "attachments"),
      workspaceDir: join(directory, "workspace"),
      memoryDir: join(directory, "memory"),
    },
  };
}
