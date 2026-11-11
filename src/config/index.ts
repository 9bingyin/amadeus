import {
  mcpNamespace,
  validateMcpServerConfig,
  type McpServerConfigResult,
} from "@earendil-works/pi-mcp";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import { agentConfigSchema, providerConfigSchema } from "./providers";

const directorySchema = z
  .string()
  .transform((path) => resolve(path))
  .refine((path) => !path.split(sep).includes(".test_home"));

type McpServer = Exclude<McpServerConfigResult, { kind: "invalid" }>;
const mcpServersSchema = z
  .record(
    z.string(),
    z.looseObject({
      oauth: z.never().optional(),
    }),
  )
  .default({})
  .transform((entries, context) => {
    const servers: [string, McpServer][] = [];
    for (const [name, entry] of Object.entries(entries)) {
      const result = validateMcpServerConfig(name, entry);
      if (result.kind === "invalid")
        context.addIssue({
          code: "custom",
          path: [name],
          message: result.error,
        });
      else servers.push([name, result]);
    }
    return Object.fromEntries(servers);
  })
  .refine((servers) => {
    const names = Object.keys(servers);
    return new Set(names.map(mcpNamespace)).size === names.length;
  });

export const telegramConfigSchema = z.strictObject({
  token: z.string().trim().min(1),
  allowedUserIds: z.array(z.int().positive()).nonempty(),
  inputWindowMs: z.int().nonnegative().default(700),
  streaming: z.boolean().default(false),
});
export type TelegramConfig = z.infer<typeof telegramConfigSchema>;

const configSchema = z
  .strictObject({
    channels: z
      .strictObject({
        telegram: telegramConfigSchema.optional(),
      })
      .refine((channels) =>
        Object.values(channels).some((value) => value !== undefined),
      ),
    agent: agentConfigSchema,
    providers: z.record(z.string().min(1), providerConfigSchema),
    workspace: z.string().trim().min(1).default("workspace"),
    mcpServers: mcpServersSchema,
  })
  .refine(
    ({ agent, providers }) => providers[agent.model.provider] !== undefined,
    {
      path: ["agent", "model", "provider"],
    },
  );

export type Config = z.infer<typeof configSchema> & { stateDirectory: string };

export function parseConfig(value: unknown, directory: string): Config {
  const stateDirectory = directorySchema.parse(directory);
  const config = configSchema.parse(value);
  for (const server of Object.values(config.mcpServers)) {
    if (server.kind === "stdio" && server.config.cwd !== undefined) {
      server.config.cwd = directorySchema.parse(
        resolve(stateDirectory, server.config.cwd),
      );
    }
  }
  return {
    ...config,
    stateDirectory,
    workspace: directorySchema.parse(resolve(stateDirectory, config.workspace)),
  };
}

export async function loadConfig(path?: string): Promise<Config> {
  const directory = resolve(
    process.env["AMADEUS_HOME"] || join(homedir(), ".amadeus"),
  );
  const value: unknown = await Bun.file(
    path ?? join(directory, "config.json"),
  ).json();
  return parseConfig(value, directory);
}
