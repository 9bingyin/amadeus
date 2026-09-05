import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveConfigPath } from "../src/config";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("loadConfig", () => {
  test("STT 自定义 baseURL 保留网关路径，拒绝不安全地址且错误不回显地址", async () => {
    const base = {
      telegram: { botToken: "token", allowedUserIds: [1] },
      pi: { command: "pi", args: [] },
    };
    const gateway =
      "https://gateway.ai.cloudflare.com/v1/test-account/test-gateway/openrouter";
    const valid = await writeConfig({
      ...base,
      stt: { enabled: true, apiKey: "synthetic-key", baseURL: `${gateway}/` },
    });
    expect((await loadConfig(valid.path)).stt).toMatchObject({
      baseURL: gateway,
    });
    for (const baseURL of [
      "",
      "not-a-url",
      "http://example.invalid",
      "https://synthetic-secret@example.invalid",
      "https://example.invalid?key=synthetic-secret",
      "https://example.invalid#synthetic-secret",
      123,
    ]) {
      const invalid = await writeConfig({
        ...base,
        stt: { enabled: true, apiKey: "synthetic-key", baseURL },
      });
      await expect(loadConfig(invalid.path)).rejects.toThrow("stt.baseURL");
      try {
        await loadConfig(invalid.path);
      } catch (error) {
        expect(String(error)).not.toContain("synthetic-secret");
      }
    }
  });
  test("STT 默认禁用，启用时独立凭证和模型默认值生效", async () => {
    const base = {
      telegram: { botToken: "token", allowedUserIds: [1] },
      pi: { command: "pi", args: [] },
    };
    const disabled = await writeConfig(base);
    expect((await loadConfig(disabled.path)).stt).toEqual({ enabled: false });
    const enabled = await writeConfig({
      ...base,
      stt: { enabled: true, apiKey: "synthetic-stt-key" },
    });
    expect((await loadConfig(enabled.path)).stt).toEqual({
      enabled: true,
      apiKey: "synthetic-stt-key",
      baseURL: "https://openrouter.ai/api/v1",
      model: "microsoft/mai-transcribe-2",
      ffmpegCommand: "ffmpeg",
      timeoutMs: 60000,
      maxDurationSeconds: 600,
    });
    for (const stt of [
      { enabled: true },
      { enabled: true, apiKey: "" },
      { typo: true },
      { timeoutMs: 0 },
      { maxDurationSeconds: -1 },
    ]) {
      const invalid = await writeConfig({ ...base, stt });
      await expect(loadConfig(invalid.path)).rejects.toThrow();
    }
  });
  test("按配置文件目录解析自定义路径", async () => {
    const { directory, path } = await writeConfig({
      telegram: {
        botToken: "token",
        allowedUserIds: [1],
        streamResponses: true,
      },
      pi: { command: "pi", args: ["--approve"] },
      paths: {
        stateDir: "data/state",
        sessionDir: "data/sessions",
        attachmentsDir: "data/attachments",
        workspaceDir: "workspace",
      },
    });

    const config = await loadConfig(path);

    expect(config.paths).toEqual({
      stateDir: join(directory, "data/state"),
      sessionDir: join(directory, "data/sessions"),
      attachmentsDir: join(directory, "data/attachments"),
      workspaceDir: join(directory, "workspace"),
      memoryDir: join(homedir(), ".amadeus/memory"),
    });
    expect(config.telegram.allowedUserIds).toEqual([1]);
    expect(config.telegram.streamResponses).toBeTrue();
  });

  test("未配置 paths 时使用用户目录默认值", async () => {
    const { path } = await writeConfig({
      telegram: { botToken: "token", allowedUserIds: [1] },
      pi: { command: "pi", args: [] },
    });

    const config = await loadConfig(path);

    expect(config.paths).toEqual({
      stateDir: join(homedir(), ".amadeus/state"),
      sessionDir: join(homedir(), ".amadeus/sessions"),
      attachmentsDir: join(homedir(), ".amadeus/attachments"),
      workspaceDir: join(homedir(), ".amadeus/workspace"),
      memoryDir: join(homedir(), ".amadeus/memory"),
    });
    expect(config.telegram.streamResponses).toBeFalse();
    expect(config.memory).toEqual({
      enabled: false,
      extractionTimeoutMs: 60_000,
      qmd: {
        enabled: true,
        command: "qmd",
        searchTimeoutMs: 60_000,
      },
    });
  });

  test("展开显式配置的用户主目录路径", async () => {
    const { path } = await writeConfig({
      telegram: { botToken: "token", allowedUserIds: [1] },
      pi: { command: "pi", args: [] },
      paths: {
        stateDir: "~/.amadeus/custom-state",
        sessionDir: "~/custom-sessions",
        attachmentsDir: "~",
        workspaceDir: "~/custom-workspace",
        memoryDir: "~/custom-memory",
      },
    });

    expect((await loadConfig(path)).paths).toEqual({
      stateDir: join(homedir(), ".amadeus/custom-state"),
      sessionDir: join(homedir(), "custom-sessions"),
      attachmentsDir: homedir(),
      workspaceDir: join(homedir(), "custom-workspace"),
      memoryDir: join(homedir(), "custom-memory"),
    });
  });

  test("允许只覆盖部分路径", async () => {
    const { directory, path } = await writeConfig({
      telegram: { botToken: "token", allowedUserIds: [1] },
      pi: { command: "pi", args: [] },
      paths: { attachmentsDir: "files" },
    });

    const config = await loadConfig(path);

    expect(config.paths).toEqual({
      stateDir: join(homedir(), ".amadeus/state"),
      sessionDir: join(homedir(), ".amadeus/sessions"),
      attachmentsDir: join(directory, "files"),
      workspaceDir: join(homedir(), ".amadeus/workspace"),
      memoryDir: join(homedir(), ".amadeus/memory"),
    });
  });

  test("解析异步记忆配置", async () => {
    const { directory, path } = await writeConfig({
      telegram: { botToken: "token", allowedUserIds: [1] },
      pi: { command: "pi", args: [] },
      memory: {
        enabled: true,
        extractionModel: "provider/model",
        extractionTimeoutMs: 30_000,
        qmd: {
          enabled: false,
          command: "custom-qmd",
          searchTimeoutMs: 5_000,
        },
      },
      paths: { memoryDir: "memory" },
    });

    const config = await loadConfig(path);

    expect(config.memory).toEqual({
      enabled: true,
      extractionModel: "provider/model",
      extractionTimeoutMs: 30_000,
      qmd: {
        enabled: false,
        command: "custom-qmd",
        searchTimeoutMs: 5_000,
      },
    });
    expect(config.paths.memoryDir).toBe(join(directory, "memory"));
  });

  test("拒绝未知记忆字段和无效超时", async () => {
    const unknown = await writeConfig({
      telegram: { botToken: "token", allowedUserIds: [1] },
      pi: { command: "pi", args: [] },
      memory: { typo: true },
    });
    await expect(loadConfig(unknown.path)).rejects.toThrow(
      "memory 包含未知字段：typo",
    );

    const invalidTimeout = await writeConfig({
      telegram: { botToken: "token", allowedUserIds: [1] },
      pi: { command: "pi", args: [] },
      memory: { extractionTimeoutMs: 0 },
    });
    await expect(loadConfig(invalidTimeout.path)).rejects.toThrow(
      "memory.extractionTimeoutMs 必须是正安全整数",
    );
  });

  test("拒绝未知字段和重复白名单", async () => {
    const { path } = await writeConfig({
      telegram: { botToken: "token", allowedUserIds: [1, 1], typo: true },
      pi: { command: "pi", args: [] },
    });

    await expect(loadConfig(path)).rejects.toThrow(
      "telegram 包含未知字段：typo",
    );
  });

  test("拒绝旧的文件型状态路径字段", async () => {
    const { path } = await writeConfig({
      telegram: { botToken: "token", allowedUserIds: [1] },
      pi: { command: "pi", args: [] },
      paths: { stateFile: "data/state.json" },
    });

    await expect(loadConfig(path)).rejects.toThrow(
      "paths 包含未知字段：stateFile",
    );
  });

  test("拒绝旧的 pi.cwd 工作区字段", async () => {
    const { path } = await writeConfig({
      telegram: { botToken: "token", allowedUserIds: [1] },
      pi: { command: "pi", cwd: ".", args: [] },
    });

    await expect(loadConfig(path)).rejects.toThrow("pi 包含未知字段：cwd");
  });

  test("保留用户配置的 Pi extension 和工具参数", async () => {
    const args = [
      "--extension",
      "custom.ts",
      "--no-extensions",
      "--tools",
      "read,bash",
      "--exclude-tools",
      "bash",
    ];
    const { path } = await writeConfig({
      telegram: { botToken: "token", allowedUserIds: [1] },
      pi: { command: "pi", args },
    });

    expect((await loadConfig(path)).pi.args).toEqual(args);
  });

  test("拒绝覆盖桥接服务管理的 Pi RPC 参数", async () => {
    const { path } = await writeConfig({
      telegram: { botToken: "token", allowedUserIds: [1] },
      pi: { command: "pi", args: ["--no-session"] },
    });

    await expect(loadConfig(path)).rejects.toThrow(
      "不能覆盖桥接服务管理的参数",
    );
  });
});

describe("resolveConfigPath", () => {
  test("只接受默认路径或 --config", () => {
    expect(resolveConfigPath([])).toEndWith("config.json");
    expect(resolveConfigPath(["--config", "custom.json"])).toEndWith(
      "custom.json",
    );
    expect(() => resolveConfigPath(["custom.json"])).toThrow("用法");
  });
});

async function writeConfig(value: unknown): Promise<{
  directory: string;
  path: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "amadeus-config-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify(value));
  return { directory, path };
}
