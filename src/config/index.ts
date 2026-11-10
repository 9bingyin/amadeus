import { dirname, resolve, sep } from "node:path";
import { z } from "zod";

export const modelConfigSchema = z.strictObject({
  id: z.string().trim().min(1),
  baseUrl: z.httpUrl().default("https://api.openai.com/v1"),
  apiKeyEnv: z.string().trim().min(1).default("OPENAI_API_KEY"),
  contextWindow: z.number().int().positive().safe().optional(),
  maxTokens: z.number().int().positive().safe().optional(),
});

const configSchema = z.strictObject({
  telegram: z.strictObject({
    tokenEnv: z.string().trim().min(1).default("TELEGRAM_BOT_TOKEN"),
    allowedUserIds: z.array(z.number().int().positive().safe()).nonempty(),
  }),
  model: modelConfigSchema,
  stateDirectory: z.string().trim().min(1).default(".amadeus"),
  instructions: z
    .string()
    .default("你是 Amadeus，一个简洁、可靠的个人助手。使用简体中文回复。"),
});

export type Config = z.infer<typeof configSchema>;

export function parseConfig(value: unknown, directory: string): Config {
  const stateDirectory = configSchema.shape.stateDirectory
    .transform((path) => resolve(directory, path))
    .refine((path) => !path.split(sep).includes(".test_home"));
  return configSchema.extend({ stateDirectory }).parse(value);
}

export async function loadConfig(path: string): Promise<Config> {
  const value: unknown = await Bun.file(path).json();
  return parseConfig(value, dirname(resolve(path)));
}
