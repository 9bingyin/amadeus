import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ZodError } from "zod";
import { createAgentModels } from "../agent/providers";
import { loadConfig, parseConfig, telegramConfigSchema } from ".";

test("配置保留安全边界，HOME 是唯一状态目录", async () => {
  const input: unknown = await Bun.file(
    new URL("../../config.example.json", import.meta.url),
  ).json();
  const { stateDirectory, ...config } = parseConfig(input, "/tmp/amadeus");
  const telegram = telegramConfigSchema.parse(config.channels.telegram);
  function withTelegram(patch: Record<string, unknown>) {
    return { ...config, channels: { telegram: { ...telegram, ...patch } } };
  }
  expect(stateDirectory).toBe("/tmp/amadeus");
  expect(config.workspace).toBe("/tmp/amadeus/workspace");
  expect(
    parseConfig({ ...config, workspace: "custom" }, "/tmp/amadeus").workspace,
  ).toBe("/tmp/amadeus/custom");
  expect(
    parseConfig({ ...config, workspace: "/tmp/project" }, "/tmp/amadeus")
      .workspace,
  ).toBe("/tmp/project");
  expect(telegram.inputWindowMs).toBe(700);
  const models = createAgentModels(config);
  expect(
    models.getModel("openai", config.agent.model.modelId)?.input,
  ).toContain("image");
  const auth = await models.getAuth("openai");
  expect(auth?.auth.apiKey).toBe(config.providers["openai"]?.apiKey);
  expect(auth?.source).toBe("config.json");
  for (const value of [undefined, " "]) {
    expect(() => parseConfig(withTelegram({ token: value }), "/tmp")).toThrow(
      ZodError,
    );
    expect(() =>
      parseConfig(
        { ...config, providers: { openai: { apiKey: value } } },
        "/tmp",
      ),
    ).toThrow(ZodError);
  }
  for (const patch of [
    { tokenEnv: "TELEGRAM_BOT_TOKEN" },
    { inputWindowMs: -1 },
    { allowedUserIds: [] },
    { allowedUserIds: [-1] },
    { allowedUserIds: [Number.MAX_SAFE_INTEGER + 1] },
  ])
    expect(() => parseConfig(withTelegram(patch), "/tmp")).toThrow(ZodError);
  for (const patch of [
    { workspace: ".test_home" },
    { workspace: " " },
    { stateDirectory: "/tmp/elsewhere" },
    { telegram },
    { channels: {} },
    { channels: { discord: {} } },
    {
      providers: {
        openai: { apiKey: "test-key", apiKeyEnv: "OPENAI_API_KEY" },
      },
    },
    {
      providers: {
        openai: { apiKey: "test-key", baseUrl: "file:///tmp/model" },
      },
    },
  ])
    expect(() => parseConfig({ ...config, ...patch }, "/tmp")).toThrow(
      ZodError,
    );
  expect(() => parseConfig(config, "/tmp/.test_home/new")).toThrow(ZodError);
  expect(() =>
    createAgentModels({
      ...config,
      agent: {
        ...config.agent,
        model: { provider: "openai", modelId: "unconfigured-custom-model" },
      },
    }),
  ).toThrow(ZodError);
});

test("AMADEUS_HOME 控制配置和状态位置，显式配置路径不改变 HOME", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amadeus-home-test-"));
  const previous = process.env["AMADEUS_HOME"];
  try {
    const source = await Bun.file(
      new URL("../../config.example.json", import.meta.url),
    ).text();
    const userHome = join(directory, "user");
    const defaultHome = join(userHome, ".amadeus");
    const customHome = join(directory, "custom");
    await mkdir(defaultHome, { recursive: true });
    await mkdir(customHome);
    await Bun.write(join(defaultHome, "config.json"), source);
    await Bun.write(join(customHome, "config.json"), source);
    // Bun 缓存启动时的 homedir，在独立进程中验证默认 HOME。
    for (const value of [undefined, ""]) {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: userHome };
      if (value === undefined) delete env["AMADEUS_HOME"];
      else env["AMADEUS_HOME"] = value;
      const result = Bun.spawnSync(
        [
          process.execPath,
          "--eval",
          `import { loadConfig } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)}; console.log((await loadConfig()).stateDirectory);`,
        ],
        { cwd: directory, env, stdout: "pipe", stderr: "pipe" },
      );
      if (!result.success) throw result;
      expect(new TextDecoder().decode(result.stdout).trim()).toBe(defaultHome);
    }

    process.env["AMADEUS_HOME"] = relative(process.cwd(), customHome);
    expect((await loadConfig()).stateDirectory).toBe(customHome);
    const path = join(directory, "override.json");
    await Bun.write(
      path,
      JSON.stringify({
        channels: { telegram: { token: "123:TEST", allowedUserIds: [9] } },
        agent: { model: { provider: "openai", modelId: "gpt-5.4" } },
        providers: { openai: { apiKey: "test-key" } },
      }),
    );
    process.env["AMADEUS_HOME"] = customHome;
    const explicit = await loadConfig(relative(process.cwd(), path));
    expect(explicit.channels.telegram?.allowedUserIds).toEqual([9]);
    expect(explicit.stateDirectory).toBe(customHome);

    process.env["AMADEUS_HOME"] = join(directory, ".test_home");
    await expect(loadConfig(path)).rejects.toBeInstanceOf(ZodError);
    const missing = join(directory, "missing");
    process.env["AMADEUS_HOME"] = missing;
    await expect(loadConfig()).rejects.toMatchObject({
      code: "ENOENT",
      path: join(missing, "config.json"),
    });
  } finally {
    if (previous === undefined) delete process.env["AMADEUS_HOME"];
    else process.env["AMADEUS_HOME"] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP 配置复用官方校验，保护 cwd 并拒绝当前不支持的 OAuth", () => {
  const base = {
    channels: { telegram: { token: "123:TEST", allowedUserIds: [1] } },
    agent: { model: { provider: "openai", modelId: "test" } },
    providers: { openai: { apiKey: "test-key" } },
  };
  const config = parseConfig(
    {
      ...base,
      mcpServers: {
        local: {
          command: "bun",
          args: ["server.ts"],
          cwd: "tools",
          env: { KEY: "${LITERAL}" },
        },
        remote: {
          type: "streamable-http",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer configured" },
        },
      },
    },
    "/tmp/amadeus",
  );
  expect(config.mcpServers["local"]?.kind).toBe("stdio");
  expect(config.mcpServers["local"]?.config["cwd"]).toBe("/tmp/amadeus/tools");
  expect(config.mcpServers["remote"]?.kind).toBe("http");
  for (const mcpServers of [
    { bad: { url: "file:///tmp/mcp" } },
    { bad: { type: "sse", url: "https://example.com/mcp" } },
    { bad: { command: "bun", cwd: ".test_home" } },
    { bad: { url: "https://example.com/mcp", oauth: {} } },
    { "a-b": { command: "bun" }, a_b: { command: "bun" } },
  ])
    expect(() => parseConfig({ ...base, mcpServers }, "/tmp")).toThrow(
      ZodError,
    );
});
