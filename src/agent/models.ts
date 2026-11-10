import { envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import {
  createModels,
  createProvider,
  type Models,
} from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { modelConfigSchema, type Config } from "../config";

export function createAgentModels(config: Config["model"]): Models {
  const known = openaiProvider()
    .getModels()
    .find((model) => model.id === config.id);
  const { contextWindow, maxTokens } = modelConfigSchema
    .required({ contextWindow: true, maxTokens: true })
    .parse({
      ...config,
      contextWindow: config.contextWindow ?? known?.contextWindow,
      maxTokens: config.maxTokens ?? known?.maxTokens,
    });
  const model = {
    ...known,
    id: config.id,
    name: known?.name ?? config.id,
    provider: "openai",
    api: "openai-responses",
    baseUrl: config.baseUrl,
    reasoning: known?.reasoning ?? false,
    input: ["text"],
    contextWindow,
    maxTokens,
    cost: known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } satisfies Model<"openai-responses">;
  const models = createModels();
  models.setProvider(
    createProvider({
      id: "openai",
      baseUrl: config.baseUrl,
      auth: { apiKey: envApiKeyAuth("模型 API Key", [config.apiKeyEnv]) },
      models: [model],
      api: openAIResponsesApi(),
    }),
  );
  return models;
}
