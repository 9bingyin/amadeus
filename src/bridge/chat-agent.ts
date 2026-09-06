import { AbortController, type AbortSignal } from "abort-controller";
import { stat } from "node:fs/promises";
import { errorName, noopInfoLogger, type InfoLogger } from "../logging/logger";
import type {
  IndexedTelegramMessage,
  NormalizedTelegramMessage,
  AttachmentDownloader,
} from "../telegram/types";
import {
  PiRpcTransportCloseError,
  type PiRpcClientLike,
} from "../pi-rpc/client";
import {
  parseClearedQueue,
  parseCompactionResult,
  parseLatestAssistantEntryId,
  parseNewSessionResult,
  parseSessionState,
  parseSessionStats,
  requireSuccess,
} from "../pi-rpc/response-data";
import type {
  PiAssistantMessage,
  PiRpcEvent,
  PiRpcResponse,
  PiRpcSessionState,
} from "../pi-rpc/types";
import {
  getOrCreateChatState,
  indexMessage,
  reserveOutboundToolCall,
  type StateStore,
} from "../state";
import {
  isMemoryToolName,
  parseMemorySnapshotResult,
  parseMemoryToolArguments,
  parseMemoryToolResult,
  parseMemoryUiRequest,
  MEMORY_PROTOCOL_TITLE,
  type MemorySnapshotResult,
  type MemoryToolArguments,
  type MemoryToolName,
  type MemoryToolResult,
} from "../../plugins/memory/protocol";
import {
  isTelegramOutboundToolName,
  parseTelegramOutboundFileArgs,
  parseTelegramOutboundUiRequest,
  telegramOutboundKind,
  TELEGRAM_OUTBOUND_PROTOCOL_TITLE,
  type TelegramOutboundFileArgs,
  type TelegramOutboundResult,
  type TelegramOutboundUiRequest,
  type TelegramOutboundToolName,
} from "../../plugins/telegram/protocol";
import { compilePiPrompt, type CompiledPiPrompt } from "./prompt-compiler";

export interface PiTextStreamGeneration {
  revision: number;
  segment: number;
}

export type PiTextStreamEvent =
  | {
      type: "start";
      generation: PiTextStreamGeneration;
      replyToMessageId: number;
    }
  | {
      type: "delta";
      generation: PiTextStreamGeneration;
      text: string;
    }
  | { type: "abort"; generation: PiTextStreamGeneration };

export type PiCompactionResult =
  | { status: "busy" }
  | { status: "cancelled" }
  | { status: "not_needed" }
  | {
      status: "compacted";
      tokensBefore: number;
      estimatedTokensAfter: number;
    };

export interface PiChatStatus {
  sessionId: string;
  workspaceDir?: string;
  provider: string | null;
  model: string | null;
  thinkingLevel: string | null;
  contextUsage:
    | {
        tokens: number | null;
        contextWindow: number;
        percent: number | null;
      }
    | undefined;
}

export interface PiFinalResponse {
  chatId: number;
  replyToMessageId: number;
  sessionId: string;
  piEntryId: string;
  text: string;
  stopReason: "stop" | "length" | "error";
  errorMessage?: string;
  signal?: AbortSignal;
  isCurrent?(): boolean;
}

export interface PiAgentCallbacks {
  onEvent(chatId: number, event: PiRpcEvent): void;
  onTextStream?(chatId: number, event: PiTextStreamEvent): void;
  onTextStreamFinish?(
    chatId: number,
    generation: PiTextStreamGeneration,
  ): Promise<void>;
  onFinalResponse(response: PiFinalResponse): Promise<void>;
  onCompactionStart?(chatId: number): void;
  onCompactionFinish?(chatId: number): Promise<void>;
  onTelegramOutbound?(
    request: PiTelegramOutboundRequest,
  ): Promise<TelegramOutboundResult>;
  onMemoryRequest?(
    request: PiMemoryRequest,
  ): Promise<MemorySnapshotResult | MemoryToolResult>;
  onSessionCheckpoint?(
    chatId: number,
    session: { id: string; file: string },
  ): Promise<void>;
  onSessionReset(chatId: number, replyToMessageId: number): Promise<void>;
  onError(
    chatId: number,
    error: Error,
    replyToMessageId?: number,
  ): Promise<void>;
}

export type PiMemoryRequest =
  | {
      kind: "snapshot";
      chatId: number;
      sessionId: string;
    }
  | {
      kind: "tool";
      chatId: number;
      sessionId: string;
      revision: number;
      toolCallId: string;
      args: MemoryToolArguments;
      signal?: AbortSignal;
    };

export interface PiTelegramOutboundRequest {
  chatId: number;
  replyToMessageId: number;
  sessionId: string;
  piEntryId: string;
  revision: number;
  toolCallId: string;
  toolName: TelegramOutboundToolName;
  kind: "document" | "photo";
  args: TelegramOutboundFileArgs;
  signal: AbortSignal;
  deadlineAt?: number;
  isCurrent(): boolean;
}

export interface PiChatAgentOptions {
  stateStore: StateStore;
  workspaceDir?: string;
  downloader: AttachmentDownloader;
  callbacks: PiAgentCallbacks;
  logger?: InfoLogger;
}

const COMPACTION_NOT_NEEDED_ERRORS = new Set([
  "Already compacted",
  "Nothing to compact (session too small)",
]);

function isCompactionNotNeeded(response: PiRpcResponse): boolean {
  return !response.success && COMPACTION_NOT_NEEDED_ERRORS.has(response.error);
}

export class PiChatAgent {
  readonly #chatId: number;
  readonly #client: PiRpcClientLike;
  readonly #options: PiChatAgentOptions;
  readonly #logger: InfoLogger;
  #sessionId: string;
  #running: boolean;
  #latestEnqueuedRevision = 0;
  #controlEpoch = 0;
  #activeControlEpoch = 0;
  #activeRevision = 0;
  #activeReplyToMessageId = 0;
  #candidate: FinalCandidate | undefined;
  #textStreamSegment = 0;
  #activeTextStreamGeneration: PiTextStreamGeneration | undefined;
  #queuedSteers: QueuedSteer[] = [];
  readonly #activatedSteerRevisions = new Set<number>();
  #commandQueue = Promise.resolve();
  #deliveryQueue = Promise.resolve();
  #sessionMaterializationQueue = Promise.resolve();
  #pendingSubmissions = 0;
  #activeDeliveryController: AbortController | undefined;
  #compacting = false;
  #cancelCompaction = false;
  #abortTasks = new Set<Promise<void>>();
  readonly #pendingTelegramTools = new Map<string, PendingTelegramTool>();
  readonly #observedTelegramToolCalls = new Set<string>();
  readonly #activeTelegramToolControllers = new Map<string, AbortController>();
  readonly #telegramToolTasks = new Set<Promise<void>>();
  readonly #pendingMemoryTools = new Map<string, PendingMemoryTool>();
  readonly #activeMemoryReadControllers = new Set<AbortController>();
  readonly #memoryTasks = new Set<Promise<void>>();
  #unsubscribe: () => void;
  #unsubscribeFatal: () => void;
  readonly #onBroken: () => void;
  readonly #isManagerClosed: () => boolean;
  #closing = false;
  #closePromise: Promise<void> | undefined;

  private constructor(
    chatId: number,
    client: PiRpcClientLike,
    options: PiChatAgentOptions,
    state: PiRpcSessionState,
    onBroken: () => void,
    isManagerClosed: () => boolean,
  ) {
    this.#chatId = chatId;
    this.#client = client;
    this.#options = options;
    this.#logger = options.logger ?? noopInfoLogger;
    this.#sessionId = state.sessionId;
    this.#running = state.isStreaming || state.pendingMessageCount > 0;
    this.#onBroken = onBroken;
    this.#isManagerClosed = isManagerClosed;
    this.#unsubscribe = client.onEvent((event) => this.#handleEvent(event));
    this.#unsubscribeFatal = client.onFatal((error) =>
      this.#handleFatal(error),
    );
  }

  static async initialize(
    chatId: number,
    client: PiRpcClientLike,
    options: PiChatAgentOptions,
    onBroken: () => void,
    isManagerClosed: () => boolean,
    expectedSessionId?: string,
  ): Promise<PiChatAgent> {
    const unsubscribeStartup = client.onEvent((event) => {
      if (
        event.type === "extension_ui_request" &&
        isInteractiveUiMethod(event.method)
      ) {
        void client
          .notify({
            type: "extension_ui_response",
            id: event.id,
            cancelled: true,
          })
          .catch(() => undefined);
      }
    });
    try {
      const stateResponse = await client.request({ type: "get_state" });
      const state = parseSessionState(
        requireSuccess(stateResponse, "get_state"),
      );
      if (!state.sessionFile) {
        throw new Error("Pi RPC 没有返回持久 session 文件路径");
      }
      if (expectedSessionId && state.sessionId !== expectedSessionId) {
        throw new Error(
          `Pi session 不匹配：期望 ${expectedSessionId}，实际 ${state.sessionId}`,
        );
      }

      requireSuccess(
        await client.request({ type: "set_steering_mode", mode: "all" }),
        "set_steering_mode",
      );
      const materialized =
        client.sessionLaunchMode === "resume" ||
        (await isSessionFileMaterialized(state.sessionFile));
      if (client.sessionLaunchMode === "fork" && !materialized) {
        throw new Error("Pi fork session 文件尚未落盘");
      }
      await options.stateStore.update((appState) => {
        const chat = getOrCreateChatState(appState, chatId);
        chat.session = {
          id: state.sessionId,
          file: state.sessionFile ?? "",
          materialized,
        };
      });
      (options.logger ?? noopInfoLogger).info("pi_session_ready", {
        chat_id: chatId,
        resumed: expectedSessionId !== undefined,
        is_streaming: state.isStreaming,
        pending_message_count: state.pendingMessageCount,
      });

      unsubscribeStartup();
      return new PiChatAgent(
        chatId,
        client,
        options,
        state,
        onBroken,
        isManagerClosed,
      );
    } catch (error) {
      unsubscribeStartup();
      try {
        await client.close();
      } catch (closeError) {
        throw new PiRpcTransportCloseError(
          "Pi RPC client 初始化失败后无法确认子进程已关闭",
          { cause: closeError },
        );
      }
      throw error;
    }
  }

  enqueue(message: NormalizedTelegramMessage): void {
    if (this.#closing) {
      throw new Error("Pi chat agent 已经关闭");
    }
    this.#latestEnqueuedRevision += 1;
    this.#abortTextStream();
    this.#abortTelegramTools();
    this.#abortDelivery();
    const revision = this.#latestEnqueuedRevision;
    const controlEpoch = this.#controlEpoch;
    this.#pendingSubmissions += 1;
    const operation = this.#commandQueue
      .catch(() => undefined)
      .then(() => this.#submit(message, revision, controlEpoch))
      .finally(() => {
        this.#pendingSubmissions -= 1;
      });
    this.#commandQueue = operation.catch(async (error: unknown) => {
      if (controlEpoch === this.#controlEpoch) {
        await this.#notifyOperationalError(error, message.messageId);
      }
    });
  }

  async restart(): Promise<void> {
    if (this.#closing) {
      throw new Error("Pi chat agent 已经关闭");
    }
    this.#latestEnqueuedRevision += 1;
    this.#controlEpoch += 1;
    this.#cancelCompaction = this.#compacting;
    this.#candidate = undefined;
    this.#queuedSteers = [];
    this.#activatedSteerRevisions.clear();
    this.#abortTextStream();
    this.#abortTelegramTools();
    this.#abortDelivery();
    await this.close(false);
  }

  isCompacting(): boolean {
    return this.#compacting;
  }

  async compact(): Promise<PiCompactionResult> {
    if (this.#closing) {
      throw new Error("Pi chat agent 已经关闭");
    }
    if (this.#compacting) {
      return { status: "busy" };
    }
    this.#compacting = true;
    this.#cancelCompaction = false;
    const operation = this.#commandQueue
      .catch(() => undefined)
      .then(() => this.#compact());
    this.#commandQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await operation;
    } catch (error) {
      if (this.#cancelCompaction) {
        return { status: "cancelled" };
      }
      throw error;
    } finally {
      this.#compacting = false;
      this.#cancelCompaction = false;
    }
  }

  async stop(replyToMessageId: number): Promise<boolean> {
    if (this.#closing) {
      throw new Error("Pi chat agent 已经关闭");
    }
    const hadLocalWork =
      this.#pendingSubmissions > 0 ||
      this.#candidate !== undefined ||
      this.#activeDeliveryController !== undefined;
    this.#latestEnqueuedRevision += 1;
    this.#controlEpoch += 1;
    this.#abortTextStream();
    this.#abortTelegramTools();
    this.#abortDelivery();
    this.#candidate = undefined;
    this.#queuedSteers = [];
    this.#activatedSteerRevisions.clear();

    const operation = this.#commandQueue
      .catch(() => undefined)
      .then(() => this.#stop(replyToMessageId, hadLocalWork));
    this.#commandQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return await operation;
  }

  async status(): Promise<PiChatStatus> {
    if (this.#closing) {
      throw new Error("Pi chat agent 已经关闭");
    }
    const operation = this.#commandQueue
      .catch(() => undefined)
      .then(() => this.#status());
    this.#commandQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return await operation;
  }

  async newSession(replyToMessageId: number): Promise<void> {
    if (this.#closing) {
      throw new Error("Pi chat agent 已经关闭");
    }
    this.#latestEnqueuedRevision += 1;
    this.#controlEpoch += 1;
    this.#abortTextStream();
    this.#abortTelegramTools();
    this.#abortDelivery();
    const operation = this.#commandQueue
      .catch(() => undefined)
      .then(() => this.#newSession(replyToMessageId));
    this.#commandQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }

  closeGracefully(): Promise<void> {
    this.#closePromise ??= this.#closeGracefully();
    return this.#closePromise;
  }

  async #closeGracefully(): Promise<void> {
    this.#closing = true;
    this.#abortTextStream();
    await this.#drainAcceptedWork();
    this.#unsubscribe();
    this.#unsubscribeFatal();
    await this.#client.close();
  }

  async #drainAcceptedWork(): Promise<void> {
    while (true) {
      const commandQueue = this.#commandQueue;
      await commandQueue.catch(() => undefined);
      await Promise.allSettled(this.#abortTasks);
      await Promise.allSettled(this.#telegramToolTasks);
      await Promise.allSettled(this.#memoryTasks);
      const deliveryQueue = this.#deliveryQueue;
      await deliveryQueue.catch(() => undefined);
      const sessionMaterializationQueue = this.#sessionMaterializationQueue;
      await sessionMaterializationQueue.catch(() => undefined);
      if (
        commandQueue === this.#commandQueue &&
        this.#abortTasks.size === 0 &&
        this.#telegramToolTasks.size === 0 &&
        this.#memoryTasks.size === 0 &&
        deliveryQueue === this.#deliveryQueue &&
        sessionMaterializationQueue === this.#sessionMaterializationQueue
      ) {
        return;
      }
    }
  }

  close(drainCommands = true): Promise<void> {
    this.#closePromise ??= this.#close(drainCommands);
    return this.#closePromise;
  }

  async #close(drainCommands: boolean): Promise<void> {
    this.#closing = true;
    this.#abortTextStream();
    this.#abortTelegramTools();
    if (drainCommands) {
      await settleWithin(this.#commandQueue, 2_000);
    }
    this.#unsubscribe();
    this.#unsubscribeFatal();
    const clientClose = this.#client.close();
    await Promise.all([
      drainCommands ? settleWithin(clientClose, 2_000) : clientClose,
      settleWithin(this.#commandQueue, 2_000),
      settleWithin(Promise.allSettled(this.#abortTasks), 2_000),
      settleWithin(Promise.allSettled(this.#telegramToolTasks), 2_000),
      settleWithin(Promise.allSettled(this.#memoryTasks), 2_000),
      settleWithin(this.#deliveryQueue, 2_000),
      settleWithin(this.#sessionMaterializationQueue, 2_000),
    ]);
  }

  async #status(): Promise<PiChatStatus> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const state = parseSessionState(
        requireSuccess(
          await this.#client.request({ type: "get_state" }),
          "get_state",
        ),
      );
      const stats = parseSessionStats(
        requireSuccess(
          await this.#client.request({ type: "get_session_stats" }),
          "get_session_stats",
        ),
      );
      if (state.sessionId !== stats.sessionId) {
        continue;
      }
      return {
        sessionId: state.sessionId,
        ...(this.#options.workspaceDir
          ? { workspaceDir: this.#options.workspaceDir }
          : {}),
        provider: state.model?.provider ?? null,
        model: state.model?.id ?? null,
        thinkingLevel: state.thinkingLevel ?? null,
        contextUsage: stats.contextUsage,
      };
    }
    throw new Error("Pi RPC 状态来自不同 session");
  }

  async #compact(): Promise<PiCompactionResult> {
    const state = parseSessionState(
      requireSuccess(
        await this.#client.request({ type: "get_state" }),
        "get_state",
      ),
    );
    if (
      state.isStreaming ||
      state.isCompacting ||
      state.pendingMessageCount > 0 ||
      this.#running
    ) {
      return { status: "busy" };
    }

    this.#options.callbacks.onCompactionStart?.(this.#chatId);
    try {
      const response = await this.#client.request({ type: "compact" });
      if (isCompactionNotNeeded(response)) {
        return { status: "not_needed" };
      }
      return {
        status: "compacted",
        ...parseCompactionResult(requireSuccess(response, "compact")),
      };
    } finally {
      await this.#options.callbacks.onCompactionFinish?.(this.#chatId);
    }
  }

  async #stop(
    replyToMessageId: number,
    hadLocalWork: boolean,
  ): Promise<boolean> {
    const revision = this.#latestEnqueuedRevision;
    this.#candidate = undefined;
    this.#queuedSteers = [];
    this.#activatedSteerRevisions.clear();

    const initialState = parseSessionState(
      requireSuccess(
        await this.#client.request({ type: "get_state" }),
        "get_state",
      ),
    );
    const hadWork =
      hadLocalWork ||
      initialState.isStreaming ||
      initialState.isCompacting ||
      initialState.pendingMessageCount > 0 ||
      this.#running;

    if (initialState.pendingMessageCount > 0) {
      parseClearedQueue(
        requireSuccess(
          await this.#client.request({ type: "clear_queue" }),
          "clear_queue",
        ),
      );
    }

    const currentState = parseSessionState(
      requireSuccess(
        await this.#client.request({ type: "get_state" }),
        "get_state",
      ),
    );
    if (initialState.isStreaming || currentState.isStreaming || this.#running) {
      const abort = this.#client.dispatch({ type: "abort" });
      await abort.sent;
      this.#logger.info("pi_abort_sent", {
        chat_id: this.#chatId,
        message_id: replyToMessageId,
        revision,
        reason: "stop_command",
      });
      requireSuccess(await abort.response, "abort");
      this.#logger.info("pi_abort_completed", {
        chat_id: this.#chatId,
        message_id: replyToMessageId,
        revision,
      });
    }

    this.#candidate = undefined;
    this.#queuedSteers = [];
    this.#activatedSteerRevisions.clear();
    this.#running = false;
    return hadWork;
  }

  async #newSession(replyToMessageId: number): Promise<void> {
    this.#logger.info("pi_session_reset_started", {
      chat_id: this.#chatId,
      message_id: replyToMessageId,
    });
    this.#candidate = undefined;
    this.#queuedSteers = [];
    this.#activatedSteerRevisions.clear();
    const state = parseSessionState(
      requireSuccess(
        await this.#client.request({ type: "get_state" }),
        "get_state",
      ),
    );
    if (state.isStreaming || state.pendingMessageCount > 0) {
      requireSuccess(
        await this.#client.request({ type: "clear_queue" }),
        "clear_queue",
      );
      const abort = this.#client.dispatch({ type: "abort" });
      await abort.sent;
      this.#logger.info("pi_abort_sent", {
        chat_id: this.#chatId,
        message_id: replyToMessageId,
        revision: this.#latestEnqueuedRevision,
        reason: "new_session",
      });
      requireSuccess(await abort.response, "abort");
      this.#logger.info("pi_abort_completed", {
        chat_id: this.#chatId,
        message_id: replyToMessageId,
        revision: this.#latestEnqueuedRevision,
      });
    }

    const previousSessionId = this.#sessionId;
    if (this.#options.callbacks.onSessionCheckpoint && state.sessionFile) {
      const materialized = await isSessionFileMaterialized(state.sessionFile);
      if (materialized) {
        await this.#options.callbacks.onSessionCheckpoint(this.#chatId, {
          id: previousSessionId,
          file: state.sessionFile,
        });
      } else {
        const pointer =
          this.#options.stateStore.snapshot().chats[String(this.#chatId)]
            ?.session;
        if (pointer?.materialized !== false) {
          throw new Error("无法为缺失的已落盘 session 创建记忆 checkpoint");
        }
      }
    }
    const result = parseNewSessionResult(
      requireSuccess(
        await this.#client.request({ type: "new_session" }),
        "new_session",
      ),
    );
    if (result.cancelled) {
      throw new Error("Pi 扩展取消了新建 session");
    }

    const next = parseSessionState(
      requireSuccess(
        await this.#client.request({ type: "get_state" }),
        "get_state",
      ),
    );
    if (!next.sessionFile) {
      throw new Error("新 Pi session 没有持久文件路径");
    }
    if (next.sessionId === previousSessionId) {
      throw new Error("Pi new_session 没有切换 session ID");
    }

    const materialized = await isSessionFileMaterialized(next.sessionFile);
    this.#sessionId = next.sessionId;
    this.#activeControlEpoch = this.#controlEpoch;
    this.#running = false;
    this.#activeRevision = this.#latestEnqueuedRevision;
    this.#activeReplyToMessageId = replyToMessageId;
    await this.#options.stateStore.update((appState) => {
      const chat = getOrCreateChatState(appState, this.#chatId);
      chat.session = {
        id: next.sessionId,
        file: next.sessionFile ?? "",
        materialized,
      };
      chat.outboundToolCallOrder = [];
    });
    this.#pendingMemoryTools.clear();
    this.#pendingTelegramTools.clear();
    this.#observedTelegramToolCalls.clear();
    this.#logger.info("pi_session_reset_succeeded", {
      chat_id: this.#chatId,
      message_id: replyToMessageId,
    });
    await this.#options.callbacks.onSessionReset(
      this.#chatId,
      replyToMessageId,
    );
  }

  async #submit(
    message: NormalizedTelegramMessage,
    revision: number,
    controlEpoch: number,
  ): Promise<void> {
    const appState = this.#options.stateStore.snapshot();
    const chatState = appState.chats[String(this.#chatId)] ?? {
      messageOrder: [],
      messages: {},
    };
    const prompt = await compilePiPrompt(
      message,
      this.#sessionId,
      chatState,
      this.#options.downloader,
    );

    if (controlEpoch !== this.#controlEpoch) {
      return;
    }

    const liveState = parseSessionState(
      requireSuccess(
        await this.#client.request({ type: "get_state" }),
        "get_state",
      ),
    );
    if (controlEpoch !== this.#controlEpoch) {
      return;
    }
    this.#running = liveState.isStreaming;

    if (!liveState.isStreaming && liveState.pendingMessageCount > 0) {
      await this.#recoverStrandedQueue(
        prompt,
        revision,
        liveState.pendingMessageCount,
        controlEpoch,
      );
      return;
    }

    if (liveState.isStreaming) {
      await this.#sendSteer(prompt, revision, controlEpoch);
      return;
    }

    await this.#sendPrompt(prompt, revision);
  }

  async #sendPrompt(prompt: CompiledPiPrompt, revision: number): Promise<void> {
    this.#activeControlEpoch = this.#controlEpoch;
    this.#activeRevision = revision;
    this.#activeReplyToMessageId = prompt.indexedMessage.messageId;
    this.#candidate = undefined;
    this.#running = true;
    try {
      requireSuccess(
        await this.#client.request({
          type: "prompt",
          message: prompt.message,
          ...(prompt.images.length > 0 ? { images: prompt.images } : {}),
        }),
        "prompt",
      );
      this.#logger.info("pi_prompt_sent", {
        chat_id: this.#chatId,
        message_id: prompt.indexedMessage.messageId,
        revision,
        image_count: prompt.images.length,
      });
      await this.#persistAccepted(prompt);
    } catch (error) {
      this.#running = false;
      throw error;
    }
  }

  async #sendSteer(
    prompt: CompiledPiPrompt,
    revision: number,
    controlEpoch: number,
  ): Promise<void> {
    this.#activeControlEpoch = controlEpoch;
    requireSuccess(
      await this.#client.request({
        type: "steer",
        message: prompt.message,
        ...(prompt.images.length > 0 ? { images: prompt.images } : {}),
      }),
      "steer",
    );
    this.#logger.info("pi_steer_sent", {
      chat_id: this.#chatId,
      message_id: prompt.indexedMessage.messageId,
      revision,
      image_count: prompt.images.length,
    });
    if (controlEpoch !== this.#controlEpoch) {
      return;
    }
    await this.#persistAccepted(prompt);
    if (controlEpoch !== this.#controlEpoch) {
      return;
    }
    this.#queuedSteers.push({ revision, prompt });

    const abort = this.#client.dispatch({ type: "abort" });
    await abort.sent;
    this.#logger.info("pi_abort_sent", {
      chat_id: this.#chatId,
      message_id: prompt.indexedMessage.messageId,
      revision,
      reason: "newer_message",
    });
    const task = abort.response
      .then((response) => {
        requireSuccess(response, "abort");
        this.#logger.info("pi_abort_completed", {
          chat_id: this.#chatId,
          message_id: prompt.indexedMessage.messageId,
          revision,
        });
        if (controlEpoch === this.#controlEpoch) {
          this.#enqueueReconcile(prompt.indexedMessage.messageId, controlEpoch);
        }
      })
      .catch(async (error: unknown) => {
        if (controlEpoch === this.#controlEpoch) {
          await this.#notifyOperationalError(
            error,
            prompt.indexedMessage.messageId,
          );
        }
      });
    this.#abortTasks.add(task);
    void task
      .finally(() => this.#abortTasks.delete(task))
      .catch(() => undefined);
  }

  async #recoverStrandedQueue(
    current: CompiledPiPrompt,
    revision: number,
    pendingMessageCount: number,
    controlEpoch: number,
  ): Promise<void> {
    await this.#runQueueRecovery(
      "stranded_queue",
      pendingMessageCount + 1,
      controlEpoch,
      async () => {
        const cleared = parseClearedQueue(
          requireSuccess(
            await this.#client.request({ type: "clear_queue" }),
            "clear_queue",
          ),
        );
        if (
          cleared.steering.length + cleared.followUp.length <
          pendingMessageCount
        ) {
          throw new Error("Pi clear_queue 返回的消息少于 pendingMessageCount");
        }
        if (controlEpoch !== this.#controlEpoch) {
          return;
        }
        const recovered = restoreClearedQueue(
          cleared,
          this.#queuedSteers,
          current.indexedMessage,
          revision,
        );
        this.#queuedSteers = [];
        this.#activatedSteerRevisions.clear();
        await this.#replayIndependently(
          [...recovered, { revision, prompt: current }],
          controlEpoch,
        );
      },
    );
  }

  #enqueueReconcile(replyToMessageId: number, controlEpoch: number): void {
    const operation = this.#commandQueue
      .catch(() => undefined)
      .then(() => this.#reconcileAfterAbort(controlEpoch));
    this.#commandQueue = operation.catch(async (error: unknown) => {
      if (controlEpoch === this.#controlEpoch) {
        await this.#notifyOperationalError(error, replyToMessageId);
      }
    });
  }

  async #reconcileAfterAbort(controlEpoch: number): Promise<void> {
    if (controlEpoch !== this.#controlEpoch) {
      return;
    }
    const state = parseSessionState(
      requireSuccess(
        await this.#client.request({ type: "get_state" }),
        "get_state",
      ),
    );
    if (controlEpoch !== this.#controlEpoch) {
      return;
    }
    this.#running = state.isStreaming;
    if (state.isStreaming) {
      return;
    }

    if (state.pendingMessageCount === 0) {
      const latest = this.#queuedSteers.at(-1);
      if (!latest) {
        this.#scheduleDelivery();
        return;
      }
      if (
        this.#candidate?.revision === latest.revision &&
        this.#activatedSteerRevisions.has(latest.revision)
      ) {
        this.#queuedSteers = [];
        this.#activatedSteerRevisions.clear();
        this.#scheduleDelivery();
        return;
      }

      const stranded = this.#queuedSteers.splice(0);
      this.#activatedSteerRevisions.clear();
      await this.#runQueueRecovery(
        "missing_activation",
        stranded.length,
        controlEpoch,
        () => this.#replayIndependently(stranded, controlEpoch),
      );
      return;
    }

    const cleared = parseClearedQueue(
      requireSuccess(
        await this.#client.request({ type: "clear_queue" }),
        "clear_queue",
      ),
    );
    if (controlEpoch !== this.#controlEpoch) {
      return;
    }
    const latest = this.#queuedSteers.at(-1);
    if (!latest) {
      throw new Error("Pi 空闲时仍有队列消息，但本地没有可恢复的 payload");
    }
    const recovered = restoreClearedQueue(
      cleared,
      this.#queuedSteers,
      latest.prompt.indexedMessage,
      latest.revision,
    );
    this.#queuedSteers = [];
    this.#activatedSteerRevisions.clear();
    await this.#runQueueRecovery(
      "abort_reconcile",
      recovered.length,
      controlEpoch,
      () => this.#replayIndependently(recovered, controlEpoch),
    );
  }

  async #runQueueRecovery(
    reason: "stranded_queue" | "abort_reconcile" | "missing_activation",
    itemCount: number,
    controlEpoch: number,
    operation: () => Promise<void>,
  ): Promise<void> {
    this.#abortTextStream();
    this.#logger.info("pi_queue_recovery_started", {
      chat_id: this.#chatId,
      item_count: itemCount,
      reason,
    });
    try {
      await operation();
      if (controlEpoch !== this.#controlEpoch) {
        return;
      }
      this.#logger.info("pi_queue_recovery_succeeded", {
        chat_id: this.#chatId,
        item_count: itemCount,
      });
    } catch (error) {
      if (controlEpoch !== this.#controlEpoch) {
        return;
      }
      this.#logger.info("pi_queue_recovery_failed", {
        chat_id: this.#chatId,
        item_count: itemCount,
        error_name: errorName(error),
        reason: "queue_recovery_failed",
      });
      throw error;
    }
  }

  async #replayIndependently(
    items: readonly QueuedSteer[],
    controlEpoch: number,
  ): Promise<void> {
    if (items.length === 0) {
      throw new Error("没有可恢复的独立 Telegram 消息");
    }

    this.#running = true;
    for (const item of items) {
      if (controlEpoch !== this.#controlEpoch) {
        return;
      }
      this.#activeControlEpoch = controlEpoch;
      this.#activeRevision = item.revision;
      this.#activeReplyToMessageId = item.prompt.indexedMessage.messageId;
      this.#candidate = undefined;
      requireSuccess(
        await this.#client.request({
          type: "prompt",
          message: item.prompt.message,
          streamingBehavior: "steer",
          ...(item.prompt.images.length > 0
            ? { images: item.prompt.images }
            : {}),
        }),
        "prompt",
      );
      if (controlEpoch !== this.#controlEpoch) {
        return;
      }
      this.#logger.info("pi_prompt_sent", {
        chat_id: this.#chatId,
        message_id: item.prompt.indexedMessage.messageId,
        revision: item.revision,
        image_count: item.prompt.images.length,
      });
      await this.#persistAccepted(item.prompt);
    }
  }

  async #persistAccepted(prompt: CompiledPiPrompt): Promise<void> {
    await this.#options.stateStore.update((state) => {
      indexMessage(
        getOrCreateChatState(state, this.#chatId),
        prompt.indexedMessage,
      );
    });
  }

  #scheduleSessionMaterialization(): void {
    const replyToMessageId = this.#activeReplyToMessageId || undefined;
    const operation = this.#sessionMaterializationQueue
      .catch(() => undefined)
      .then(() => this.#markSessionMaterialized());
    this.#sessionMaterializationQueue = operation;
    void operation
      .catch((error: unknown) =>
        this.#notifyOperationalError(error, replyToMessageId),
      )
      .catch(() => undefined);
  }

  async #markSessionMaterialized(): Promise<void> {
    const sessionId = this.#sessionId;
    const session =
      this.#options.stateStore.snapshot().chats[String(this.#chatId)]?.session;
    if (session?.id !== sessionId || session.materialized !== false) {
      return;
    }
    if (!(await isSessionFileMaterialized(session.file))) {
      return;
    }
    await this.#options.stateStore.update((state) => {
      const current = state.chats[String(this.#chatId)]?.session;
      if (current?.id === sessionId && current.materialized === false) {
        current.materialized = true;
      }
    });
  }

  #activateSteer(content: unknown): void {
    const text = extractUserMessageText(content);
    if (text === undefined) {
      return;
    }
    const activated = this.#queuedSteers.find(
      (item) =>
        !this.#activatedSteerRevisions.has(item.revision) &&
        item.prompt.message === text,
    );
    if (!activated) {
      return;
    }

    this.#activatedSteerRevisions.add(activated.revision);
    if (this.#candidate) {
      this.#logSuppressedResponse(this.#candidate, "queued_steer");
    }
    this.#abortTextStream();
    this.#activeRevision = activated.revision;
    this.#activeReplyToMessageId = activated.prompt.indexedMessage.messageId;
    this.#candidate = undefined;
  }

  #startTextStream(): void {
    this.#abortTextStream();
    if (
      this.#activeRevision <= 0 ||
      this.#activeReplyToMessageId <= 0 ||
      !this.#options.callbacks.onTextStream
    ) {
      return;
    }
    this.#textStreamSegment += 1;
    const generation = {
      revision: this.#activeRevision,
      segment: this.#textStreamSegment,
    } satisfies PiTextStreamGeneration;
    this.#activeTextStreamGeneration = generation;
    this.#options.callbacks.onTextStream(this.#chatId, {
      type: "start",
      generation,
      replyToMessageId: this.#activeReplyToMessageId,
    });
  }

  #pushTextStreamDelta(text: string): void {
    const generation = this.#activeTextStreamGeneration;
    if (!generation || text.length === 0) {
      return;
    }
    this.#options.callbacks.onTextStream?.(this.#chatId, {
      type: "delta",
      generation,
      text,
    });
  }

  #abortTextStream(): void {
    const generation = this.#activeTextStreamGeneration;
    this.#activeTextStreamGeneration = undefined;
    if (!generation) {
      return;
    }
    this.#options.callbacks.onTextStream?.(this.#chatId, {
      type: "abort",
      generation,
    });
  }

  #abortTelegramTools(): void {
    for (const controller of this.#activeTelegramToolControllers.values()) {
      controller.abort();
    }
    for (const controller of this.#activeMemoryReadControllers) {
      controller.abort();
    }
  }

  #abortDelivery(): void {
    this.#activeDeliveryController?.abort();
    this.#activeDeliveryController = undefined;
  }

  #registerMemoryTool(toolCallId: string, toolName: string): void {
    if (!isMemoryToolName(toolName)) {
      return;
    }
    this.#pendingMemoryTools.set(toolCallId, {
      sessionId: this.#sessionId,
      revision: this.#activeRevision,
      toolName,
    });
  }

  #handleMemoryUiRequest(
    event: Extract<PiRpcEvent, { type: "extension_ui_request" }>,
  ): boolean {
    if (event.title !== MEMORY_PROTOCOL_TITLE) {
      return false;
    }
    if (event.method !== "input" || event.placeholder === undefined) {
      void this.#cancelExtensionUi(event.id).catch(() => undefined);
      return true;
    }

    let request: ReturnType<typeof parseMemoryUiRequest>;
    try {
      request = parseMemoryUiRequest(event.placeholder);
    } catch {
      void this.#cancelExtensionUi(event.id).catch(() => undefined);
      return true;
    }

    const task = this.#completeMemoryRequest(event.id, request);
    this.#memoryTasks.add(task);
    void task
      .finally(() => this.#memoryTasks.delete(task))
      .catch(() => undefined);
    return true;
  }

  async #completeMemoryRequest(
    uiRequestId: string,
    request: ReturnType<typeof parseMemoryUiRequest>,
  ): Promise<void> {
    const callback = this.#options.callbacks.onMemoryRequest;
    let result: MemorySnapshotResult | MemoryToolResult = {
      version: 1,
      status: "unavailable",
      code: "host_failure",
    };
    if (request.type === "snapshot_get") {
      try {
        result = callback
          ? parseMemorySnapshotResult(
              JSON.stringify(
                await callback({
                  kind: "snapshot",
                  chatId: this.#chatId,
                  sessionId: this.#sessionId,
                }),
              ),
            )
          : { version: 1, status: "unavailable", code: "disabled" };
      } catch {
        result = {
          version: 1,
          status: "unavailable",
          code: "host_failure",
        };
      }
    } else {
      const pending = this.#pendingMemoryTools.get(request.toolCallId);
      this.#pendingMemoryTools.delete(request.toolCallId);
      if (!pending) {
        result = rejectedMemoryResult(
          "unknown_tool_call",
          "The memory tool call is unavailable",
        );
      } else if (pending.toolName !== request.toolName) {
        result = rejectedMemoryResult(
          "tool_name_mismatch",
          "The memory tool name does not match its registered call",
        );
      } else if (
        pending.sessionId !== this.#sessionId ||
        pending.revision !== this.#latestEnqueuedRevision
      ) {
        result = rejectedMemoryResult(
          "stale_revision",
          "The memory tool call belongs to an obsolete response",
        );
      } else if (!callback) {
        result = rejectedMemoryResult("disabled", "Amadeus memory is disabled");
      } else {
        let args: MemoryToolArguments | undefined;
        try {
          args = parseMemoryToolArguments(request.toolName, request.args);
        } catch {
          result = rejectedMemoryResult(
            "invalid_arguments",
            "The memory tool arguments are invalid",
          );
        }
        if (args) {
          const mutation = isMemoryMutation(args);
          const readController = mutation ? undefined : new AbortController();
          if (readController) {
            this.#activeMemoryReadControllers.add(readController);
          }
          const timeout = readController
            ? setTimeout(() => readController.abort(), 60_000)
            : undefined;
          try {
            const hostOperation = callback({
              kind: "tool",
              chatId: this.#chatId,
              sessionId: pending.sessionId,
              revision: pending.revision,
              toolCallId: request.toolCallId,
              args,
              ...(readController ? { signal: readController.signal } : {}),
            });
            const hostResult = readController
              ? await waitForAbort(hostOperation, readController.signal)
              : await hostOperation;
            result = parseMemoryToolResult(JSON.stringify(hostResult));
          } catch {
            result = mutation
              ? {
                  version: 1,
                  status: "unknown",
                  code: "host_failure",
                  message: "The memory operation outcome cannot be confirmed",
                }
              : rejectedMemoryResult(
                  "host_failure",
                  "The memory operation failed",
                );
          } finally {
            if (timeout) {
              clearTimeout(timeout);
            }
            if (readController) {
              this.#activeMemoryReadControllers.delete(readController);
            }
          }
        }
      }
    }

    await this.#client.notify({
      type: "extension_ui_response",
      id: uiRequestId,
      value: JSON.stringify(result),
    });
  }

  #registerTelegramTool(toolCallId: string, toolName: string): void {
    if (!isTelegramOutboundToolName(toolName)) {
      return;
    }

    let rejection: TelegramOutboundResult | undefined;
    if (this.#activeRevision !== this.#latestEnqueuedRevision) {
      rejection = rejectedTelegramResult(
        "stale_revision",
        "The Telegram request belongs to an obsolete response",
      );
    }
    if (this.#observedTelegramToolCalls.has(toolCallId)) {
      rejection = unknownTelegramResult(
        "duplicate_tool_call",
        "The Telegram tool call may already have sent a file. Do not retry automatically",
      );
    }
    this.#observedTelegramToolCalls.add(toolCallId);

    this.#pendingTelegramTools.set(toolCallId, {
      toolCallId,
      toolName,
      revision: this.#activeRevision,
      replyToMessageId: this.#activeReplyToMessageId,
      sessionId: this.#sessionId,
      ...(rejection ? { rejection } : {}),
    });
  }

  #handleTelegramUiRequest(
    event: Extract<
      PiRpcEvent,
      {
        type: "extension_ui_request";
      }
    >,
  ): boolean {
    if (
      event.method !== "input" ||
      event.title !== TELEGRAM_OUTBOUND_PROTOCOL_TITLE ||
      event.placeholder === undefined
    ) {
      return false;
    }

    let request: TelegramOutboundUiRequest;
    try {
      request = parseTelegramOutboundUiRequest(event.placeholder);
    } catch {
      void this.#cancelExtensionUi(event.id).catch(() => undefined);
      return true;
    }

    const pending = this.#pendingTelegramTools.get(request.toolCallId);
    if (!pending) {
      void this.#cancelExtensionUi(event.id).catch(() => undefined);
      return true;
    }
    this.#pendingTelegramTools.delete(request.toolCallId);

    const task = this.#completeTelegramTool(event.id, pending, request);
    this.#telegramToolTasks.add(task);
    void task
      .finally(() => this.#telegramToolTasks.delete(task))
      .catch(() => undefined);
    return true;
  }

  async #completeTelegramTool(
    uiRequestId: string,
    pending: PendingTelegramTool,
    request: TelegramOutboundUiRequest,
  ): Promise<void> {
    const deadlineAt = Date.now() + 125_000;
    let result = pending.rejection;
    if (!result && pending.toolName !== request.toolName) {
      result = rejectedTelegramResult(
        "tool_name_mismatch",
        "The Telegram tool name does not match its registered call",
      );
    }
    const isCurrent = () =>
      !this.#closing &&
      pending.revision === this.#latestEnqueuedRevision &&
      pending.sessionId === this.#sessionId;

    if (!result && !isCurrent()) {
      result = rejectedTelegramResult(
        "stale_revision",
        "The Telegram request belongs to an obsolete response",
      );
    }
    let args: TelegramOutboundFileArgs | undefined;
    if (!result) {
      try {
        args = parseTelegramOutboundFileArgs(request.args);
      } catch {
        result = rejectedTelegramResult(
          "invalid_arguments",
          "Telegram tool arguments are invalid",
        );
      }
    }
    if (!result && !this.#options.callbacks.onTelegramOutbound) {
      result = rejectedTelegramResult(
        "delivery_unavailable",
        "Telegram file delivery is unavailable",
      );
    }

    let piEntryId: string | undefined;
    if (!result) {
      try {
        piEntryId = await this.#latestAssistantEntryId();
      } catch {
        result = rejectedTelegramResult(
          "pi_context_unavailable",
          "The Pi reply context is unavailable",
        );
      }
    }

    if (!result && !isCurrent()) {
      result = rejectedTelegramResult(
        "stale_revision",
        "The Telegram request belongs to an obsolete response",
      );
    }
    if (!result) {
      try {
        if (!(await this.#reserveTelegramTool(pending))) {
          result = unknownTelegramResult(
            "duplicate_tool_call",
            "The Telegram tool call may already have sent a file. Do not retry automatically",
          );
        }
      } catch {
        result = rejectedTelegramResult(
          "state_unavailable",
          "Telegram delivery cannot start because local state is unavailable",
        );
      }
    }

    if (!result && args && piEntryId) {
      const controller = new AbortController();
      this.#activeTelegramToolControllers.set(pending.toolCallId, controller);
      try {
        if (!isCurrent()) {
          result = rejectedTelegramResult(
            "stale_revision",
            "The Telegram request belongs to an obsolete response",
          );
        } else {
          try {
            result = await this.#options.callbacks.onTelegramOutbound?.({
              chatId: this.#chatId,
              replyToMessageId: pending.replyToMessageId,
              sessionId: pending.sessionId,
              piEntryId,
              revision: pending.revision,
              toolCallId: pending.toolCallId,
              toolName: pending.toolName,
              kind: telegramOutboundKind(pending.toolName),
              args,
              signal: controller.signal,
              deadlineAt,
              isCurrent,
            });
          } catch {
            result = {
              version: 1,
              status: "unknown",
              code: "delivery_result_unknown",
              message: "The Telegram delivery outcome cannot be confirmed",
            };
          }
        }
      } finally {
        if (
          this.#activeTelegramToolControllers.get(pending.toolCallId) ===
          controller
        ) {
          this.#activeTelegramToolControllers.delete(pending.toolCallId);
        }
      }
    }
    result ??= rejectedTelegramResult(
      "delivery_unavailable",
      "Telegram file delivery is unavailable",
    );

    await this.#client
      .notify({
        type: "extension_ui_response",
        id: uiRequestId,
        value: JSON.stringify(result),
      })
      .catch((error: unknown) => {
        this.#logger.info("pi_extension_response_failed", {
          chat_id: this.#chatId,
          error_name: errorName(error),
          reason: "telegram_tool_response_failed",
        });
      });
  }

  async #reserveTelegramTool(pending: PendingTelegramTool): Promise<boolean> {
    let reserved = false;
    await this.#options.stateStore.update((state) => {
      reserved = reserveOutboundToolCall(
        getOrCreateChatState(state, this.#chatId),
        pending.sessionId,
        pending.toolCallId,
      );
    });
    return reserved;
  }

  async #cancelExtensionUi(id: string): Promise<void> {
    await this.#client
      .notify({ type: "extension_ui_response", id, cancelled: true })
      .catch((error: unknown) =>
        this.#notifyOperationalError(
          error,
          this.#activeReplyToMessageId || undefined,
        ),
      );
  }

  #handleEvent(event: PiRpcEvent): void {
    if (event.type === "tool_execution_end") {
      this.#pendingMemoryTools.delete(event.toolCallId);
      this.#pendingTelegramTools.delete(event.toolCallId);
    }

    if (
      this.#activeControlEpoch !== this.#controlEpoch &&
      isTurnScopedEvent(event)
    ) {
      this.#abortTextStream();
      return;
    }

    if (event.type === "tool_execution_start") {
      this.#registerMemoryTool(event.toolCallId, event.toolName);
      this.#registerTelegramTool(event.toolCallId, event.toolName);
      this.#abortTextStream();
      this.#logger.info("pi_tool_started", {
        chat_id: this.#chatId,
        tool_call_id: event.toolCallId,
        tool_name: event.toolName,
        status: "running",
      });
    } else if (event.type === "tool_execution_end") {
      this.#logger.info("pi_tool_finished", {
        chat_id: this.#chatId,
        tool_call_id: event.toolCallId,
        tool_name: event.toolName,
        status: event.isError ? "failed" : "succeeded",
      });
    }

    if (event.type === "extension_ui_request") {
      const handled =
        this.#handleMemoryUiRequest(event) ||
        this.#handleTelegramUiRequest(event);
      if (!handled && isInteractiveUiMethod(event.method)) {
        void this.#cancelExtensionUi(event.id).catch(() => undefined);
      }
    }

    if (event.type === "agent_start") {
      this.#running = true;
    } else if (event.type === "auto_retry_start") {
      this.#candidate = undefined;
      this.#abortTextStream();
    } else if (
      event.type === "message_start" &&
      event.messageRole === "assistant"
    ) {
      this.#candidate = undefined;
      this.#startTextStream();
    } else if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      this.#pushTextStreamDelta(event.assistantMessageEvent.delta);
    } else if (event.type === "message_end" && event.message.role === "user") {
      this.#activateSteer(event.message.content);
    } else if (
      event.type === "message_end" &&
      event.message.role === "assistant"
    ) {
      if (
        this.#queuedSteers.length > 0 &&
        isEmptyAssistantError(event.message)
      ) {
        this.#logger.info("pi_response_suppressed", {
          chat_id: this.#chatId,
          message_id: this.#activeReplyToMessageId,
          revision: this.#activeRevision,
          reason: "aborted",
        });
        this.#candidate = undefined;
        this.#abortTextStream();
      } else if (isFinalAssistantMessage(event.message)) {
        this.#candidate = {
          message: event.message,
          revision: this.#activeRevision,
          replyToMessageId: this.#activeReplyToMessageId,
          ...(this.#activeTextStreamGeneration
            ? { textStreamGeneration: this.#activeTextStreamGeneration }
            : {}),
        };
      } else if (event.message.stopReason === "aborted") {
        this.#logger.info("pi_response_suppressed", {
          chat_id: this.#chatId,
          message_id: this.#activeReplyToMessageId,
          revision: this.#activeRevision,
          reason: "aborted",
        });
        this.#candidate = undefined;
        this.#abortTextStream();
      } else if (event.message.stopReason === "toolUse") {
        this.#abortTextStream();
      }
    } else if (event.type === "agent_settled") {
      this.#running = false;
      this.#scheduleSessionMaterialization();
      this.#logger.info("pi_agent_settled", {
        chat_id: this.#chatId,
        revision: this.#activeRevision,
        candidate_present: this.#candidate !== undefined,
        queued_steer_count: this.#queuedSteers.length,
      });
      if (this.#queuedSteers.length === 0) {
        if (!this.#candidate) {
          this.#abortTextStream();
        }
        this.#scheduleDelivery();
      } else {
        this.#abortTextStream();
      }
    }

    this.#options.callbacks.onEvent(this.#chatId, event);
  }

  #scheduleDelivery(): void {
    const candidate = this.#candidate;
    this.#candidate = undefined;
    if (!candidate) {
      return;
    }

    const text = candidate.message.content
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("");

    if (text.trim().length === 0) {
      this.#abortTextStream();
      this.#logSuppressedResponse(
        candidate,
        candidate.message.stopReason === "error"
          ? "model_error"
          : "empty_response",
      );
      if (candidate.message.stopReason === "error") {
        this.#queueError(
          new Error(candidate.message.errorMessage ?? "Pi 返回了空错误响应"),
          candidate.replyToMessageId,
        );
      }
      return;
    }

    const controller = new AbortController();
    this.#activeDeliveryController?.abort();
    this.#activeDeliveryController = controller;
    const isCurrent = (): boolean =>
      !controller.signal.aborted &&
      candidate.revision === this.#latestEnqueuedRevision;

    this.#deliveryQueue = this.#deliveryQueue
      .catch(() => undefined)
      .then(async () => {
        if (!isCurrent()) {
          this.#logSuppressedResponse(candidate, "newer_revision");
          return;
        }
        if (candidate.textStreamGeneration) {
          if (
            sameTextStreamGeneration(
              this.#activeTextStreamGeneration,
              candidate.textStreamGeneration,
            )
          ) {
            this.#activeTextStreamGeneration = undefined;
          }
          await this.#options.callbacks.onTextStreamFinish?.(
            this.#chatId,
            candidate.textStreamGeneration,
          );
        }
        if (!isCurrent()) {
          this.#logSuppressedResponse(candidate, "newer_revision");
          return;
        }
        const piEntryId = await this.#latestAssistantEntryId();
        if (!isCurrent()) {
          this.#logSuppressedResponse(candidate, "newer_revision");
          return;
        }
        await this.#options.callbacks.onFinalResponse({
          chatId: this.#chatId,
          replyToMessageId: candidate.replyToMessageId,
          sessionId: this.#sessionId,
          piEntryId,
          text,
          stopReason: candidate.message.stopReason,
          signal: controller.signal,
          isCurrent,
          ...(candidate.message.errorMessage
            ? { errorMessage: candidate.message.errorMessage }
            : {}),
        });
      })
      .catch(async (error: unknown) => {
        if (!controller.signal.aborted) {
          await this.#notifyOperationalError(error, candidate.replyToMessageId);
        }
      })
      .finally(() => {
        if (this.#activeDeliveryController === controller) {
          this.#activeDeliveryController = undefined;
        }
      });
  }

  #logSuppressedResponse(
    candidate: FinalCandidate,
    reason:
      "empty_response" | "model_error" | "newer_revision" | "queued_steer",
  ): void {
    this.#logger.info("pi_response_suppressed", {
      chat_id: this.#chatId,
      message_id: candidate.replyToMessageId,
      revision: candidate.revision,
      reason,
    });
  }

  async #latestAssistantEntryId(): Promise<string> {
    const response = await this.#client.request({ type: "get_entries" });
    return parseLatestAssistantEntryId(requireSuccess(response, "get_entries"));
  }

  #handleFatal(error: Error): void {
    if (this.#closing || this.#isManagerClosed()) {
      return;
    }
    this.#closing = true;
    this.#controlEpoch += 1;
    this.#abortTextStream();
    this.#abortTelegramTools();
    this.#abortDelivery();
    this.#unsubscribe();
    this.#unsubscribeFatal();
    if (!(error instanceof PiRpcTransportCloseError)) {
      this.#onBroken();
    }
    this.#logger.info("pi_agent_fatal", {
      chat_id: this.#chatId,
      revision: this.#activeRevision,
      error_name: errorName(error),
      reason: "rpc_process_failed",
    });
    void this.#notifyError(
      error,
      this.#activeReplyToMessageId || undefined,
    ).catch(() => undefined);
  }

  #queueError(error: Error, replyToMessageId: number): void {
    this.#deliveryQueue = this.#deliveryQueue
      .catch(() => undefined)
      .then(() => this.#notifyOperationalError(error, replyToMessageId));
  }

  async #notifyOperationalError(
    error: unknown,
    replyToMessageId?: number,
  ): Promise<void> {
    if (this.#closing || this.#isManagerClosed()) {
      return;
    }
    await this.#notifyError(error, replyToMessageId);
  }

  async #notifyError(error: unknown, replyToMessageId?: number): Promise<void> {
    await this.#options.callbacks.onError(
      this.#chatId,
      error instanceof Error ? error : new Error("Unknown Pi failure"),
      replyToMessageId,
    );
  }
}

interface PendingMemoryTool {
  sessionId: string;
  revision: number;
  toolName: MemoryToolName;
}

interface PendingTelegramTool {
  toolCallId: string;
  toolName: TelegramOutboundToolName;
  revision: number;
  replyToMessageId: number;
  sessionId: string;
  rejection?: TelegramOutboundResult;
}

interface QueuedSteer {
  revision: number;
  prompt: CompiledPiPrompt;
}

interface FinalCandidate {
  message: FinalAssistantMessage;
  revision: number;
  replyToMessageId: number;
  textStreamGeneration?: PiTextStreamGeneration;
}

type FinalAssistantMessage = PiAssistantMessage & {
  stopReason: "stop" | "length" | "error";
};

function sameTextStreamGeneration(
  left: PiTextStreamGeneration | undefined,
  right: PiTextStreamGeneration,
): boolean {
  return left?.revision === right.revision && left.segment === right.segment;
}

function extractUserMessageText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    )
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
  return text.length > 0 ? text : undefined;
}

function rejectedMemoryResult(code: string, message: string): MemoryToolResult {
  return { version: 1, status: "rejected", code, message };
}

function rejectedTelegramResult(
  code: string,
  message: string,
): TelegramOutboundResult {
  return { version: 1, status: "rejected", code, message };
}

function unknownTelegramResult(
  code: string,
  message: string,
): TelegramOutboundResult {
  return { version: 1, status: "unknown", code, message };
}

function isInteractiveUiMethod(method: string): boolean {
  return (
    method === "select" ||
    method === "confirm" ||
    method === "input" ||
    method === "editor"
  );
}

function isMemoryMutation(args: MemoryToolArguments): boolean {
  return (
    args.toolName === "memory_write" ||
    args.toolName === "memory_forget" ||
    args.toolName === "memory_restore" ||
    (args.toolName === "scratchpad" && args.action !== "list")
  );
}

function isTurnScopedEvent(event: PiRpcEvent): boolean {
  return (
    event.type === "agent_start" ||
    event.type === "auto_retry_start" ||
    event.type === "message_start" ||
    event.type === "message_update" ||
    event.type === "message_end" ||
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_update" ||
    event.type === "tool_execution_end" ||
    event.type === "queue_update"
  );
}

function isEmptyAssistantError(message: PiAssistantMessage): boolean {
  return (
    message.stopReason === "error" &&
    message.content.every(
      (content) => content.type !== "text" || content.text.trim().length === 0,
    )
  );
}

function isFinalAssistantMessage(
  message: PiAssistantMessage,
): message is FinalAssistantMessage {
  return (
    message.stopReason === "stop" ||
    message.stopReason === "length" ||
    message.stopReason === "error"
  );
}

async function isSessionFileMaterialized(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) {
      throw new Error("Pi session 路径不是普通文件");
    }
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function waitForAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error("Memory read aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new Error("Memory read aborted"));
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

async function settleWithin(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    operation.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer) {
    clearTimeout(timer);
  }
}

function restoreClearedQueue(
  cleared: { steering: string[]; followUp: string[] },
  localSteers: readonly QueuedSteer[],
  fallbackIndex: IndexedTelegramMessage,
  fallbackRevision: number,
): QueuedSteer[] {
  const available = [...localSteers];
  const recovered = cleared.steering.map((message): QueuedSteer => {
    const matchIndex = available.findIndex(
      (item) => item.prompt.message === message,
    );
    if (matchIndex < 0) {
      return {
        revision: fallbackRevision,
        prompt: textOnlyPrompt(message, fallbackIndex),
      };
    }
    const [matched] = available.splice(matchIndex, 1);
    return (
      matched ?? {
        revision: fallbackRevision,
        prompt: textOnlyPrompt(message, fallbackIndex),
      }
    );
  });
  recovered.push(
    ...cleared.followUp.map((message) => ({
      revision: fallbackRevision,
      prompt: textOnlyPrompt(message, fallbackIndex),
    })),
  );
  return recovered;
}

function textOnlyPrompt(
  message: string,
  indexedMessage: IndexedTelegramMessage,
): CompiledPiPrompt {
  return { message, images: [], indexedMessage };
}
