import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, AssistantEntry } from "@earendil-works/pi-durable";
import { contentText } from "@earendil-works/pi-ai/utils/text";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z, ZodError } from "zod";
import { openAgent } from ".";
import { parseConfig } from "../config";
import { apiSchema } from "../config/providers";
import { createAgentModels } from "./providers";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function config(providers: unknown, provider = "openai", modelId = "gpt-5.4") {
  return parseConfig(
    {
      channels: { telegram: { token: "123:TEST", allowedUserIds: [1] } },
      agent: { model: { provider, modelId }, thinkingLevel: "high" },
      providers,
    },
    "/tmp/amadeus-provider-tests",
  );
}

const definition = { id: "chat", contextWindow: 128000, maxTokens: 2048 };

test("内置 provider 保留完整目录及非聊天实现，只注册显式配置的 provider", async () => {
  const cfg = config({
    openai: { apiKey: "literal-key" },
    openrouter: { apiKey: "router-key", compat: { imageInput: "assets" } },
  });
  const models = createAgentModels(cfg);
  expect(models.getProviders().map(({ id }) => id)).toEqual([
    "openai",
    "openrouter",
  ]);
  expect(models.getModels("openai").length).toBeGreaterThan(1);
  expect(models.getModelsOfType("classifier", "openai").length).toBeGreaterThan(
    0,
  );
  expect(models.getModelsOfType("image", "openrouter").length).toBeGreaterThan(
    0,
  );
  expect(typeof models.getProvider("openai")?.classify).toBe("function");
  expect(typeof models.getProvider("openrouter")?.generateImages).toBe(
    "function",
  );
  expect(
    models.getModelsOfType("classifier", "openrouter")[0]?.compat?.imageInput,
  ).toBe("assets");
  expect(models.getModel("openai", "gpt-5.4")?.input).toContain("image");
  const previous = process.env["OPENAI_API_KEY"];
  process.env["OPENAI_API_KEY"] = "must-not-use";
  try {
    expect((await models.getAuth("openai"))?.auth.apiKey).toBe("literal-key");
  } finally {
    if (previous === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = previous;
  }
});

test("provider、模型定义和 modelOverrides 依次覆盖，嵌套元数据不丢失", () => {
  const models = createAgentModels(
    config({
      openai: {
        apiKey: "key",
        baseUrl: "https://provider.example/v1",
        compat: { supportsOpenAIGrammarTools: false },
        models: [
          {
            id: "gpt-5.4",
            baseUrl: "https://model.example/v1",
            cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
            inputLimits: {
              images: {
                resize: { maxWidth: 1000, maxHeight: 900, maxBytes: 1000000 },
              },
            },
            compat: { supportsStrictMode: false },
            samplingParams: { temperature: 0.5 },
            samplingParamsByThinkingLevel: { high: { top_p: 0.8, seed: 1 } },
          },
        ],
        modelOverrides: {
          "gpt-5.4": {
            name: "Configured GPT",
            cost: { input: 5 },
            inputLimits: { images: { resize: { maxWidth: 800 } } },
            samplingParams: { top_k: 10 },
            samplingParamsByThinkingLevel: { high: { seed: 2 } },
          },
          nonexistent: { contextWindow: 1 },
        },
      },
    }),
  );
  const model = models.getModel("openai", "gpt-5.4");
  expect(model?.name).toBe("Configured GPT");
  expect(model?.baseUrl).toBe("https://model.example/v1");
  expect(model?.input).toContain("image");
  expect(model?.cost).toMatchObject({
    input: 5,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
  });
  expect(model?.inputLimits?.images?.resize).toMatchObject({
    maxWidth: 800,
    maxHeight: 900,
    maxBytes: 1000000,
  });
  expect(model?.compat).toMatchObject({
    supportsOpenAIGrammarTools: false,
    supportsStrictMode: false,
  });
  expect(model?.samplingParams).toEqual({ temperature: 0.5, top_k: 10 });
  expect(model?.samplingParamsByThinkingLevel?.high).toEqual({
    top_p: 0.8,
    seed: 2,
  });
  expect(models.getModel("openai", "nonexistent")).toBeUndefined();
});

test("未知模型必须声明真实能力，内置 provider 的新模型继承协议及地址", () => {
  for (const baseUrl of ["http://localhost:1234/v1", "http://[::1]:1234/v1"]) {
    const models = createAgentModels(
      config(
        {
          gateway: {
            apiKey: "key",
            api: "openai-completions",
            baseUrl,
            models: [definition],
          },
        },
        "gateway",
        "chat",
      ),
    );
    expect(models.getModel("gateway", "chat")?.baseUrl).toBe(baseUrl);
  }
  for (const patch of [
    { contextWindow: undefined },
    { maxTokens: undefined },
  ]) {
    expect(() =>
      createAgentModels(
        config(
          {
            gateway: {
              apiKey: "key",
              api: "openai-completions",
              baseUrl: "http://localhost:1234/v1",
              models: [{ ...definition, ...patch }],
            },
          },
          "gateway",
          "chat",
        ),
      ),
    ).toThrow(ZodError);
  }
  const models = createAgentModels(
    config(
      { openai: { apiKey: "key", models: [definition] } },
      "openai",
      "chat",
    ),
  );
  expect(models.getModel("openai", "chat")).toMatchObject({
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    contextWindow: 128000,
  });
  expect(() =>
    createAgentModels(
      config({ openai: { apiKey: "key" } }, "openai", "missing"),
    ),
  ).toThrow(ZodError);
});

test("新格式拒绝旧临时字段、OAuth、未知协议和未配置的 provider", () => {
  const cfg = config({ openai: { apiKey: "key" } });
  const { stateDirectory: _, ...raw } = cfg;
  for (const patch of [
    { model: { id: "gpt-5.4", apiKey: "key" } },
    { instructions: "legacy" },
    { providers: { openai: { apiKey: "key", oauth: {} } } },
    { providers: { openai: { apiKey: "key", api: "unknown-api" } } },
    { providers: {} },
    { agent: { ...cfg.agent, thinkingLevel: "extreme" } },
  ])
    expect(() => parseConfig({ ...raw, ...patch }, "/tmp")).toThrow(ZodError);
  expect(() =>
    parseConfig(
      {
        ...raw,
        providers: {
          openai: {
            apiKey: "key",
            modelOverrides: {
              "gpt-5.4": {
                inputLimits: { images: { resize: { maxWidth: -1 } } },
              },
            },
          },
        },
      },
      "/tmp",
    ),
  ).toThrow(ZodError);
});

for (const api of apiSchema.options) {
  test(`${api} 使用官方协议、配置凭据与 headers，错误内容原样返回`, async () => {
    const requests: Headers[] = [];
    const paths: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        requests.push(new Headers(request.headers));
        paths.push(new URL(request.url).pathname);
        return Response.json(
          {
            error: {
              message: "native-original-denial",
              code: 401,
              status: "UNAUTHENTICATED",
            },
          },
          { status: 401 },
        );
      },
    });
    cleanups.push(async () => {
      await server.stop(true);
    });
    const provider = {
      "openai-responses": "openai",
      "openai-completions": "openai",
      "anthropic-messages": "anthropic",
      "google-generative-ai": "google",
    }[api];
    const models = createAgentModels(
      config(
        {
          [provider]: {
            apiKey: "!literal-key",
            api,
            baseUrl: new URL("/v1", server.url).href,
            headers: { "X-Provider": "${LITERAL}" },
            models: [{ ...definition, headers: { "X-Model": "model-header" } }],
          },
        },
        provider,
        "chat",
      ),
    );
    const model = z
      .custom<NonNullable<ReturnType<typeof models.getModel>>>(
        (value) => value !== undefined,
      )
      .parse(models.getModel(provider, "chat"));
    const result = await models.completeSimple(model, {
      messages: [{ role: "user", content: "ping", timestamp: 1 }],
    });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("native-original-denial");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.get("x-provider")).toBe("${LITERAL}");
    expect(requests[0]?.get("x-model")).toBe("model-header");
    const header =
      api === "anthropic-messages"
        ? "x-api-key"
        : api === "google-generative-ai"
          ? "x-goog-api-key"
          : "authorization";
    expect(requests[0]?.get(header)).toContain("!literal-key");
    expect(paths[0]).toContain(
      api === "openai-responses"
        ? "/responses"
        : api === "openai-completions"
          ? "/chat/completions"
          : api === "anthropic-messages"
            ? "/messages"
            : ":streamGenerateContent",
    );
  });
}

test("自定义 provider 经 Harness 完成生成，模型引用及思考配置原生持久化", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amadeus-provider-harness-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      const chunk = {
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 1,
        model: "chat",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "native reply" },
            finish_reason: "stop",
          },
        ],
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  cleanups.push(async () => {
    await server.stop(true);
  });
  const cfg = parseConfig(
    {
      channels: { telegram: { token: "123:TEST", allowedUserIds: [1] } },
      agent: {
        model: { provider: "gateway", modelId: "chat" },
        thinkingLevel: "high",
      },
      providers: {
        gateway: {
          apiKey: "key",
          api: "openai-completions",
          baseUrl: new URL("/v1", server.url).href,
          models: [definition],
        },
      },
    },
    directory,
  );
  const agent = await openAgent(cfg, createAgentModels(cfg));
  cleanups.push(() => agent.close());
  const context = BACKGROUND_CONTEXT;
  const root = await agent.harness.root(context, {
    agent: agent.configuration,
  });
  agent.harness.resume();
  const result = await (
    await root.submit({ type: "input", content: "ping" }, context)
  ).wait(context);
  expect(result.status).toBe("done");
  const answer = (await root.entries({}, 10, undefined, context)).items
    .find(AssistantEntry.is)
    ?.model?.find((message) => message.role === "assistant");
  expect(contentText(answer?.content ?? [])).toBe("native reply");
  expect(
    await agent.harness.snapshot(AgentDoc, root.id, context),
  ).toMatchObject({
    model: { provider: "gateway", modelId: "chat" },
    thinkingLevel: "high",
  });
});
