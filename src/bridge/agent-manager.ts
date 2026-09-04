import { errorName, noopInfoLogger, type InfoLogger } from "../logging/logger";
import { PiRpcTransportCloseError } from "../pi-rpc/client";
import {
  PiSessionFileMissingError,
  type PiRpcClientFactory,
} from "../pi-rpc/client-factory";
import { hasSeenMessage } from "../state";
import type { NormalizedTelegramMessage } from "../telegram/types";
import {
  PiChatAgent,
  type PiChatAgentOptions,
  type PiChatStatus,
  type PiCompactionResult,
} from "./chat-agent";

export type {
  PiAgentCallbacks,
  PiChatStatus,
  PiCompactionResult,
  PiFinalResponse,
  PiTelegramOutboundRequest,
  PiTextStreamEvent,
  PiTextStreamGeneration,
} from "./chat-agent";

export interface PiAgentManagerOptions extends PiChatAgentOptions {
  clientFactory: PiRpcClientFactory;
}

export class PiAgentManager {
  readonly #options: PiAgentManagerOptions;
  readonly #logger: InfoLogger;
  readonly #agents = new Map<number, Promise<PiChatAgent>>();
  readonly #initializeMissingSessionPromises = new WeakSet<
    Promise<PiChatAgent>
  >();
  readonly #agentGenerations = new Map<number, number>();
  readonly #recoveringChats = new Set<number>();
  #shutdownRequested = false;
  #closed = false;

  constructor(options: PiAgentManagerOptions) {
    this.#options = options;
    this.#logger = options.logger ?? noopInfoLogger;
  }

  async submit(message: NormalizedTelegramMessage): Promise<void> {
    if (this.#closed) {
      throw new Error("Pi agent manager 已经关闭");
    }
    if (
      hasSeenMessage(
        this.#options.stateStore.snapshot().chats[String(message.chatId)],
        message.messageId,
      )
    ) {
      this.#logger.info("pi_input_suppressed", {
        chat_id: message.chatId,
        message_id: message.messageId,
        reason: "already_seen",
      });
      return;
    }
    const agent = await this.#getAgent(message.chatId);
    if (this.#closed) {
      await agent.close();
      throw new Error("Pi agent manager 已经关闭");
    }
    agent.enqueue(message);
  }

  async restart(chatId: number): Promise<void> {
    if (this.#closed) {
      throw new Error("Pi agent manager 已经关闭");
    }
    await this.#replaceAgent(chatId, this.#getAgentPromise(chatId));
  }

  async compact(chatId: number): Promise<PiCompactionResult> {
    if (this.#closed) {
      throw new Error("Pi agent manager 已经关闭");
    }
    const agent = await this.#getAgent(chatId);
    if (this.#closed) {
      await agent.close();
      throw new Error("Pi agent manager 已经关闭");
    }
    return await agent.compact();
  }

  async stop(chatId: number, replyToMessageId: number): Promise<boolean> {
    if (this.#closed) {
      throw new Error("Pi agent manager 已经关闭");
    }
    const current = this.#getAgentPromise(chatId);
    const agent = await current;
    if (this.#closed) {
      await agent.close();
      throw new Error("Pi agent manager 已经关闭");
    }
    if (agent.isCompacting()) {
      await this.#replaceAgent(chatId, current);
      return true;
    }
    return await agent.stop(replyToMessageId);
  }

  async status(chatId: number): Promise<PiChatStatus> {
    if (this.#closed) {
      throw new Error("Pi agent manager 已经关闭");
    }
    const agent = await this.#getAgent(chatId);
    if (this.#closed) {
      await agent.close();
      throw new Error("Pi agent manager 已经关闭");
    }
    return await agent.status();
  }

  async newSession(chatId: number, replyToMessageId: number): Promise<void> {
    if (this.#closed) {
      throw new Error("Pi agent manager 已经关闭");
    }
    const agent = await this.#getAgentPromise(chatId, true);
    if (this.#closed) {
      await agent.close();
      throw new Error("Pi agent manager 已经关闭");
    }
    await agent.newSession(replyToMessageId);
  }

  beginShutdown(): void {
    this.#shutdownRequested = true;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const agents = await Promise.allSettled(this.#agents.values());
    const closed = await Promise.allSettled(
      agents.flatMap((result) =>
        result.status === "fulfilled" ? [result.value.closeGracefully()] : [],
      ),
    );
    this.#agents.clear();
    this.#agentGenerations.clear();
    this.#recoveringChats.clear();
    const failures = [
      ...agents.flatMap((result) =>
        result.status === "rejected" &&
        result.reason instanceof PiRpcTransportCloseError
          ? [result.reason]
          : [],
      ),
      ...closed
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => result.reason),
    ];
    if (failures.length > 0) {
      throw new AggregateError(failures, "Pi agent manager 关闭不完整");
    }
  }

  async #getAgent(chatId: number): Promise<PiChatAgent> {
    return await this.#getAgentPromise(chatId);
  }

  #getAgentPromise(
    chatId: number,
    initializeMissingSession = false,
  ): Promise<PiChatAgent> {
    const existing = this.#agents.get(chatId);
    if (existing) {
      if (
        !initializeMissingSession ||
        this.#initializeMissingSessionPromises.has(existing)
      ) {
        return existing;
      }
      const upgraded = existing.catch(async (error: unknown) => {
        if (
          this.#closed ||
          this.#shutdownRequested ||
          this.#agents.get(chatId) !== upgraded ||
          !(error instanceof PiSessionFileMissingError)
        ) {
          throw error;
        }
        return await this.#createAgent(
          chatId,
          this.#nextGeneration(chatId),
          true,
        );
      });
      this.#initializeMissingSessionPromises.add(upgraded);
      this.#agents.set(chatId, upgraded);
      void upgraded
        .catch((error: unknown) => {
          if (
            !(error instanceof PiRpcTransportCloseError) &&
            this.#agents.get(chatId) === upgraded
          ) {
            this.#agents.delete(chatId);
          }
        })
        .catch(() => undefined);
      return upgraded;
    }

    const generation = this.#nextGeneration(chatId);
    const created = this.#createAgent(
      chatId,
      generation,
      initializeMissingSession,
    );
    if (initializeMissingSession) {
      this.#initializeMissingSessionPromises.add(created);
    }
    this.#agents.set(chatId, created);
    void created
      .catch((error: unknown) => {
        if (
          !(error instanceof PiRpcTransportCloseError) &&
          this.#agents.get(chatId) === created
        ) {
          this.#agents.delete(chatId);
        }
      })
      .catch(() => undefined);
    return created;
  }

  #nextGeneration(chatId: number): number {
    const generation = (this.#agentGenerations.get(chatId) ?? 0) + 1;
    this.#agentGenerations.set(chatId, generation);
    return generation;
  }

  async #replaceAgent(
    chatId: number,
    current: Promise<PiChatAgent>,
  ): Promise<PiChatAgent> {
    const generation = this.#nextGeneration(chatId);
    const replacement = current.then(async (agent) => {
      await agent.restart();
      if (this.#closed) {
        throw new Error("Pi agent manager 已经关闭");
      }
      return await this.#createAgent(chatId, generation);
    });
    this.#agents.set(chatId, replacement);
    try {
      return await replacement;
    } catch (error) {
      if (
        !(error instanceof PiRpcTransportCloseError) &&
        this.#agents.get(chatId) === replacement
      ) {
        this.#agents.delete(chatId);
      }
      throw error;
    }
  }

  async #createAgent(
    chatId: number,
    generation: number,
    initializeMissingSession = false,
  ): Promise<PiChatAgent> {
    const chatState = this.#options.stateStore.snapshot().chats[String(chatId)];
    const recovering = this.#recoveringChats.has(chatId);
    if (recovering) {
      this.#logger.info("pi_agent_recovery_started", { chat_id: chatId });
    }
    this.#logger.info("pi_agent_create_started", {
      chat_id: chatId,
      resume_session: chatState?.session !== undefined,
    });
    try {
      const session = chatState?.session;
      const client = await this.#options.clientFactory.create(
        chatId,
        session
          ? {
              file: session.file,
              missingPolicy:
                initializeMissingSession || session.materialized === false
                  ? "initialize"
                  : "error",
            }
          : undefined,
      );
      const agent = await PiChatAgent.initialize(
        chatId,
        client,
        this.#options,
        () => {
          if (this.#agentGenerations.get(chatId) !== generation) {
            return;
          }
          this.#agents.delete(chatId);
          this.#recoveringChats.add(chatId);
        },
        () => this.#shutdownRequested || this.#closed,
        client.sessionLaunchMode === "fork" ||
          client.sessionLaunchMode === "initialize"
          ? undefined
          : session?.id,
      );
      if (recovering) {
        this.#recoveringChats.delete(chatId);
        this.#logger.info("pi_agent_recovered", { chat_id: chatId });
      }
      return agent;
    } catch (error) {
      this.#logger.info("pi_agent_create_failed", {
        chat_id: chatId,
        error_name: errorName(error),
        reason: "agent_create_failed",
      });
      if (recovering) {
        this.#logger.info("pi_agent_recovery_failed", {
          chat_id: chatId,
          error_name: errorName(error),
          reason: "agent_recovery_failed",
        });
      }
      throw error;
    }
  }
}
