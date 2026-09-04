import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { PiMemoryRequest } from "../bridge/chat-agent";
import type { AppConfig } from "../config";
import type { InfoLogger } from "../logging/logger";
import type { AppState } from "../state";
import { MemoryCoordinator } from "./coordinator";
import { MemoryExtractor } from "./extractor";
import { QmdCoordinator } from "./qmd";
import { MemoryStore } from "./store";

export class MemoryRuntime {
  readonly #coordinator: MemoryCoordinator;
  readonly #qmd: QmdCoordinator;

  private constructor(coordinator: MemoryCoordinator, qmd: QmdCoordinator) {
    this.#coordinator = coordinator;
    this.#qmd = qmd;
  }

  static async create(
    config: AppConfig,
    logger: InfoLogger,
  ): Promise<MemoryRuntime | undefined> {
    if (!config.memory.enabled) {
      return undefined;
    }
    const metadataDir = join(config.paths.stateDir, "memory");
    const workerSessionDir = join(metadataDir, "worker-sessions");
    await Promise.all([
      mkdir(config.paths.memoryDir, { recursive: true }),
      mkdir(workerSessionDir, { recursive: true }),
    ]);
    const store = await MemoryStore.open({
      memoryDir: config.paths.memoryDir,
      stateDir: metadataDir,
    });
    const qmd = new QmdCoordinator({
      store,
      memoryDir: store.getMemoryDir(),
      command: config.memory.qmd.command,
      enabled: config.memory.qmd.enabled,
      searchTimeoutMs: config.memory.qmd.searchTimeoutMs,
    });
    const extractor = new MemoryExtractor({
      command: config.pi.command,
      cwd: config.paths.workspaceDir,
      sessionDir: workerSessionDir,
      ...(config.memory.extractionModel
        ? { model: config.memory.extractionModel }
        : {}),
      timeoutMs: config.memory.extractionTimeoutMs,
      logger,
    });
    const coordinator = new MemoryCoordinator({ store, extractor, qmd });
    return new MemoryRuntime(coordinator, qmd);
  }

  start(): void {
    this.#qmd.start();
    this.#coordinator.start();
  }

  handleRequest(request: PiMemoryRequest) {
    return this.#coordinator.handleRequest(request);
  }

  async beginShutdown(): Promise<void> {
    const results = await Promise.allSettled([
      this.#qmd.close(),
      this.#coordinator.beginShutdown(),
    ]);
    const failures = results
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Memory shutdown start was incomplete",
      );
    }
  }

  checkpointSession(input: {
    chatId: number;
    sessionId: string;
    sessionFile: string;
  }): Promise<void> {
    return this.#coordinator.checkpointSession(input);
  }

  async close(state: AppState): Promise<void> {
    const checkpoints = Object.entries(state.chats)
      .map(([chatId, chat]) => ({
        chatId: Number(chatId),
        session: chat.session,
      }))
      .filter(
        (
          item,
        ): item is {
          chatId: number;
          session: { id: string; file: string; materialized?: boolean };
        } =>
          Number.isSafeInteger(item.chatId) &&
          item.chatId > 0 &&
          item.session !== undefined &&
          item.session.materialized !== false,
      )
      .map(({ chatId, session }) =>
        this.#coordinator.checkpointSession({
          chatId,
          sessionId: session.id,
          sessionFile: session.file,
        }),
      );
    const checkpointResults = await Promise.allSettled(checkpoints);
    const closeResults = await Promise.allSettled([
      this.#coordinator.close(),
      this.#qmd.close(),
    ]);
    const failures = [...checkpointResults, ...closeResults]
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Memory runtime close was incomplete");
    }
  }
}
