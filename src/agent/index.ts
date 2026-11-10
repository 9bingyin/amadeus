import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  type AgentChange,
  type Registry,
  type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config";
import { acquireLock } from "./lock";

export type Agent = {
  harness: Harness;
  registry: Registry;
  configuration: AgentChange;
  close(): Promise<void>;
};

export async function openAgent(
  config: Pick<Config, "stateDirectory" | "model" | "instructions">,
  models: Models,
): Promise<Agent> {
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  const lock = await acquireLock(config.stateDirectory);

  const context = BACKGROUND_CONTEXT;
  let storage: Storage | undefined;
  let harness: Harness | undefined;
  try {
    storage = await openNodeSqliteStorage(
      join(config.stateDirectory, "session.sqlite"),
    );
    const registry = createRegistry();
    harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: { afterFailedRun: "continue" },
        onReport: (report) => console.error(report.error),
      },
      context,
    );
    const opened = harness;
    let closing: Promise<void> | undefined;
    return {
      harness: opened,
      registry,
      configuration: {
        model: { provider: "openai", modelId: config.model.id },
        instructions: config.instructions,
      },
      close() {
        closing ??= opened.close(context).finally(() => lock.close());
        return closing;
      },
    };
  } catch (error) {
    try {
      if (harness) await harness.close(context);
      else await storage?.close(context);
    } finally {
      await lock.close();
    }
    throw error;
  }
}
