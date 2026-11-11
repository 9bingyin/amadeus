import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import {
  createRegistry,
  Harness,
  type AgentChange,
  type Registry,
  type Storage,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import {
  SqliteStorage,
  type SqliteDatabase,
} from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  createCodingTools,
  type ImageProcessor,
} from "@earendil-works/pi-durable/tools";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config";
import { openMcp, type Mcp } from "../mcp";
import { createHistoryExtension } from "./history";
import { acquireLock } from "./lock";
import { createMemoryExtension } from "./memory";
import { createSystemPrompt } from "./prompt";
import { createSkillsExtension } from "./skills";

export type Agent = {
  stateDirectory: string;
  images: ImageProcessor;
  harness: Harness;
  registry: Registry;
  configuration: AgentChange;
  close(): Promise<void>;
};

export async function openAgent(
  config: Pick<Config, "stateDirectory" | "workspace" | "agent" | "mcpServers">,
  models: Models,
): Promise<Agent> {
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  await using resources = new AsyncDisposableStack();
  resources.use(await acquireLock(config.stateDirectory));

  const context = BACKGROUND_CONTEXT;
  let database: SqliteDatabase | undefined;
  let storage: Storage | undefined;
  let harness: Harness | undefined;
  let sandbox: CodemodeSandbox | undefined;
  let mcp: Mcp | undefined;
  // 逆序释放，启动失败时也保证 Harness/storage → sandbox → MCP → lock。
  resources.defer(() => mcp?.close());
  resources.defer(() => sandbox?.close());
  resources.defer(async () => {
    if (harness) await harness.close(context);
    else if (storage) await storage.close(context);
    else await database?.close();
  });

  await mkdir(config.workspace, { recursive: true, mode: 0o700 });
  database = await openNodeSqliteDatabase(
    join(config.stateDirectory, "session.sqlite"),
  );
  storage = await SqliteStorage.open(database);
  const registry = createRegistry();
  registry.install(
    await createSystemPrompt(config.stateDirectory, config.workspace),
  );
  registry.install(await createMemoryExtension(config.stateDirectory));
  const images = await createNodePhotonImages();
  registry.install(createCodingTools({ images }));
  registry.install(await createHistoryExtension(database));
  registry.install(createSkillsExtension(config));
  mcp = await openMcp(config.mcpServers, config.workspace);
  registry.install(mcp.extension);
  sandbox = new CodemodeSandbox();
  registry.install(
    createCodemodeExtension({ sandbox, namespaces: mcp.namespaces }),
  );
  harness = await Harness.open(
    storage,
    {
      models,
      registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? config.workspace }),
      settings: {
        afterFailedRun: "continue",
        steeringMode: "all",
        followUpMode: "all",
      },
      onReport: (report) => console.error(report.error),
    },
    context,
  );
  const cleanup = resources.move();
  let closing: Promise<void> | undefined;
  return {
    stateDirectory: config.stateDirectory,
    images,
    harness,
    registry,
    configuration: {
      ...config.agent,
      // 提示由原生 section 提供，清除旧会话保存的 instructions。
      instructions: null,
      thinkingLevel: config.agent.thinkingLevel ?? null,
      cwd: config.workspace,
    },
    close() {
      closing ??= cleanup.disposeAsync();
      return closing;
    },
  };
}
