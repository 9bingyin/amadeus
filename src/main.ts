import { Bot } from "grammy";
import { openAgent } from "./agent";
import { createAgentModels } from "./agent/models";
import { loadConfig } from "./config";
import { configureTelegram, runTelegram } from "./telegram";

async function main(): Promise<void> {
  const config = await loadConfig(Bun.argv[2] ?? "config.json");
  const bot = new Bot(process.env[config.telegram.tokenEnv] ?? "");
  const agent = await openAgent(config, createAgentModels(config.model));
  try {
    await configureTelegram(bot, agent, config.telegram.allowedUserIds);
    await runTelegram(bot, agent.harness);
  } finally {
    await agent.close();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
