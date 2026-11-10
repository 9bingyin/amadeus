import { ProviderCompatSchema } from "@earendil-works/pi-ai/providers/compat-schema";
import {
  MODEL_THINKING_LEVELS,
  ModelCostSchema,
  ModelCostTierSchema,
  ModelInputLimitsSchema,
  ModelPromptCacheSchema,
  ThinkingLevelMapSchema,
} from "@earendil-works/pi-ai/providers/model-schema";
import { arr, compile, type Schema } from "@earendil-works/pi-schema";
import { z } from "zod";

function nativeSchema<T>(schema: Schema<T>) {
  return z.custom<T>(compile(schema).check);
}

export const apiSchema = z.enum([
  "openai-responses",
  "openai-completions",
  "anthropic-messages",
  "google-generative-ai",
]);
export const baseUrlSchema = z.url({ protocol: /^https?$/ });
const headers = z.record(z.string(), z.string());
const partialCost = z.strictObject({
  input: z.number().nonnegative().optional(),
  output: z.number().nonnegative().optional(),
  cacheRead: z.number().nonnegative().optional(),
  cacheWrite: z.number().nonnegative().optional(),
  tiers: nativeSchema(arr(ModelCostTierSchema)).optional(),
});
export const modelOverrideSchema = z.strictObject({
  name: z.string().trim().min(1).optional(),
  reasoning: z.boolean().optional(),
  input: z
    .array(z.enum(["text", "image"]))
    .nonempty()
    .optional(),
  contextWindow: z.int().positive().optional(),
  maxTokens: z.int().positive().optional(),
  cost: partialCost.optional(),
  compat: nativeSchema(ProviderCompatSchema).optional(),
  inputLimits: nativeSchema(ModelInputLimitsSchema).optional(),
  thinkingLevelMap: nativeSchema(ThinkingLevelMapSchema).optional(),
  promptCache: nativeSchema(ModelPromptCacheSchema).optional(),
  samplingParams: z.record(z.string(), z.unknown()).optional(),
  samplingParamsByThinkingLevel: z
    .partialRecord(
      z.enum(MODEL_THINKING_LEVELS),
      z.record(z.string(), z.unknown()),
    )
    .optional(),
});
export const modelDefinitionSchema = modelOverrideSchema.extend({
  id: z.string().trim().min(1),
  api: apiSchema.optional(),
  baseUrl: baseUrlSchema.optional(),
  headers: headers.optional(),
  cost: nativeSchema(ModelCostSchema).optional(),
});
export const providerConfigSchema = z.strictObject({
  name: z.string().trim().min(1).optional(),
  apiKey: z.string().trim().min(1),
  baseUrl: baseUrlSchema.optional(),
  api: apiSchema.optional(),
  headers: headers.optional(),
  authHeader: z.boolean().optional(),
  compat: nativeSchema(ProviderCompatSchema).optional(),
  models: z.array(modelDefinitionSchema).optional(),
  modelOverrides: z.record(z.string(), modelOverrideSchema).optional(),
});

export const agentConfigSchema = z.strictObject({
  model: z.strictObject({
    provider: z.string().trim().min(1),
    modelId: z.string().trim().min(1),
  }),
  thinkingLevel: z.enum(MODEL_THINKING_LEVELS).optional(),
  instructions: z
    .string()
    .default("你是 Amadeus，一个简洁、可靠的个人助手。使用简体中文回复。"),
});
