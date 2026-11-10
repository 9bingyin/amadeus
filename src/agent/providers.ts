import type { AnyModel, Api, Model } from "@earendil-works/pi-ai";
import {
  createModels,
  createProvider,
  isModelType,
  type Models,
  type Provider,
} from "@earendil-works/pi-ai/models";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ProviderCompat } from "@earendil-works/pi-ai/providers/compat-schema";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import { z } from "zod";
import type { Config } from "../config";
import { baseUrlSchema, modelOverrideSchema } from "../config/providers";

type ModelOverride = z.infer<typeof modelOverrideSchema>;

function overrideModel(model: Model<Api>, override: ModelOverride): Model<Api> {
  const result = Object.assign({}, model, override);
  if (override.cost)
    result.cost = {
      ...model.cost,
      ...override.cost,
      input: override.cost.input ?? model.cost.input,
      output: override.cost.output ?? model.cost.output,
      cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
      cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
    };
  if (override.compat) {
    const base: ProviderCompat = model.compat ?? {};
    const compat = { ...base, ...override.compat };
    if (override.compat.openRouterRouting)
      compat.openRouterRouting = {
        ...base.openRouterRouting,
        ...override.compat.openRouterRouting,
      };
    if (override.compat.vercelGatewayRouting)
      compat.vercelGatewayRouting = {
        ...base.vercelGatewayRouting,
        ...override.compat.vercelGatewayRouting,
      };
    if (override.compat.chatTemplateKwargs)
      compat.chatTemplateKwargs = {
        ...base.chatTemplateKwargs,
        ...override.compat.chatTemplateKwargs,
      };
    if (override.compat.chatTemplateArgs)
      compat.chatTemplateArgs = {
        ...base.chatTemplateArgs,
        ...override.compat.chatTemplateArgs,
      };
    result.compat = compat;
  }
  if (override.inputLimits) {
    result.inputLimits = { ...model.inputLimits, ...override.inputLimits };
    const images = override.inputLimits.images;
    if (images) {
      result.inputLimits.images = { ...model.inputLimits?.images, ...images };
      if (images.resize)
        result.inputLimits.images.resize = {
          ...model.inputLimits?.images?.resize,
          ...images.resize,
        };
    }
  }
  if (override.thinkingLevelMap)
    result.thinkingLevelMap = {
      ...model.thinkingLevelMap,
      ...override.thinkingLevelMap,
    };
  if (override.promptCache)
    result.promptCache = { ...model.promptCache, ...override.promptCache };
  if (override.samplingParams)
    result.samplingParams = {
      ...model.samplingParams,
      ...override.samplingParams,
    };
  if (override.samplingParamsByThinkingLevel) {
    result.samplingParamsByThinkingLevel = {
      ...model.samplingParamsByThinkingLevel,
    };
    for (const level of MODEL_THINKING_LEVELS) {
      const params = override.samplingParamsByThinkingLevel[level];
      if (params)
        result.samplingParamsByThinkingLevel[level] = {
          ...model.samplingParamsByThinkingLevel?.[level],
          ...params,
        };
    }
  }
  return result;
}

const modelConnectionSchema = z.object({
  api: z.string().min(1),
  baseUrl: baseUrlSchema,
  contextWindow: z.int().positive(),
  maxTokens: z.int().positive(),
});

export function createAgentModels(
  config: Pick<Config, "providers" | "agent">,
): Models {
  const builtins = new Map(
    builtinProviders().map((provider) => [provider.id, provider]),
  );
  const models = createModels();
  for (const [id, settings] of Object.entries(config.providers)) {
    const auth = {
      apiKey: {
        name: settings.name ?? id,
        resolve: async () => ({
          auth: {
            apiKey: settings.apiKey,
            headers: {
              ...settings.headers,
              ...(settings.authHeader
                ? { Authorization: `Bearer ${settings.apiKey}` }
                : {}),
            },
          },
          source: "config.json",
        }),
      },
    };
    const protocols = createProvider({
      id,
      auth,
      models: [],
      api: {
        "openai-responses": openAIResponsesApi(),
        "openai-completions": openAICompletionsApi(),
        "anthropic-messages": anthropicMessagesApi(),
        "google-generative-ai": googleGenerativeAIApi(),
      },
    });
    const base = builtins.get(id) ?? protocols;
    const getAllModels = (): AnyModel[] => {
      const entries = (base.getAllModels?.() ?? base.getModels()).map(
        (model) => {
          const routed = {
            ...model,
            baseUrl: settings.baseUrl ?? model.baseUrl,
          };
          if (!settings.compat) return routed;
          if (isModelType(routed, "chat"))
            return overrideModel(routed, { compat: settings.compat });
          if (isModelType(routed, "classifier"))
            return {
              ...routed,
              compat: { ...routed.compat, ...settings.compat },
            };
          return routed;
        },
      );
      for (const definition of settings.models ?? []) {
        const index = entries.findIndex(
          (model) => isModelType(model, "chat") && model.id === definition.id,
        );
        const known = entries[index];
        const defaults =
          known && isModelType(known, "chat") ? known : undefined;
        const connection = modelConnectionSchema.parse({
          api:
            definition.api ??
            settings.api ??
            defaults?.api ??
            base.getModels()[0]?.api,
          baseUrl:
            definition.baseUrl ??
            settings.baseUrl ??
            defaults?.baseUrl ??
            base.baseUrl,
          contextWindow: definition.contextWindow ?? defaults?.contextWindow,
          maxTokens: definition.maxTokens ?? defaults?.maxTokens,
        });
        const model: Model<Api> = Object.assign(
          {
            id: definition.id,
            name: definition.id,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
          defaults,
          connection,
          { provider: id },
        );
        const inherited = settings.compat
          ? overrideModel(model, { compat: settings.compat })
          : model;
        const configured = overrideModel(inherited, definition);
        if (index < 0) entries.push(configured);
        else entries[index] = configured;
      }
      return entries.map((model) => {
        const override = settings.modelOverrides?.[model.id];
        return override && isModelType(model, "chat")
          ? overrideModel(model, override)
          : model;
      });
    };
    // 先校验所有自定义定义；模型目录仍从官方 provider 读取，保留其原生刷新能力。
    getAllModels();
    const implementation = (model: Model<Api>): Provider =>
      base.getModels().some((entry) => entry.api === model.api)
        ? base
        : protocols;
    const provider: Provider = {
      ...base,
      id,
      name: settings.name ?? base.name,
      auth,
      ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
      getAllModels,
      getModels: () =>
        getAllModels().filter((model) => isModelType(model, "chat")),
      stream: (model, context, options) =>
        implementation(model).stream(model, context, options),
      streamSimple: (model, context, options) =>
        implementation(model).streamSimple(model, context, options),
    };
    models.setProvider(provider);
  }
  z.literal(true).parse(
    models.getModel(config.agent.model.provider, config.agent.model.modelId) !==
      undefined,
  );
  return models;
}
