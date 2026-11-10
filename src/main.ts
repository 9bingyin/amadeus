import { openAgent } from "./agent";
import { createAgentModels } from "./agent/providers";
import { loadConfig } from "./config";
import { openChannels, runChannels } from "./channels";

async function main(): Promise<void> {
  const config = await loadConfig(Bun.argv[2]);
  const agent = await openAgent(config, createAgentModels(config));
  try {
    const channels = await openChannels(agent, config.channels);
    await runChannels(channels, agent.harness);
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
