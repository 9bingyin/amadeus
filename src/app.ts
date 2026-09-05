import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Api, Bot } from "grammy";
import { AbortController as TelegramAbortController } from "abort-controller";
import { PiAgentManager } from "./bridge/agent-manager";
import { BridgeLifecycle } from "./bridge/lifecycle";
import { UnresolvableTelegramReplyError } from "./bridge/prompt-compiler";
import type { AppConfig } from "./config";
import { errorName, type InfoLogger } from "./logging/logger";
import { MemoryRuntime } from "./memory/runtime";
import { createPiRpcClientFactory } from "./pi-rpc/client-factory";
import { logServiceStarted } from "./service/lifecycle";
import { StateStore } from "./state";
import { TelegramVoiceTranscriber } from "./stt/transcriber";
import { TelegramActivityPresenter } from "./telegram/activity";
import { registerTelegramCommands } from "./telegram/commands";
import { TelegramFileDownloader } from "./telegram/download";
import {
  installTelegramIngress,
  type TelegramIngressController,
  type TelegramIngressError,
} from "./telegram/ingress";
import { TelegramFinalReplySender } from "./telegram/final-reply";
import { TelegramOutboundSender } from "./telegram/outbound";
import { createTelegramRetryTransformer } from "./telegram/retry";
import { TelegramStatusSender } from "./telegram/status";
import { TelegramDraftStreamer } from "./telegram/streaming";

export class BridgeApp {
  readonly #lifecycle: BridgeLifecycle;

  private constructor(
    bot: Bot,
    agentManager: PiAgentManager,
    ingress: TelegramIngressController,
    activity: TelegramActivityPresenter,
    drafts: TelegramDraftStreamer | undefined,
    outbound: TelegramOutboundSender,
    memory: MemoryRuntime | undefined,
    stateStore: StateStore,
    logger: InfoLogger,
  ) {
    this.#lifecycle = new BridgeLifecycle({
      beginShutdown: () => agentManager.beginShutdown(),
      registerCommands: () => registerTelegramCommands(bot.api),
      startPolling: (onReady) =>
        bot.start({
          limit: 1,
          timeout: 20,
          allowed_updates: ["message"],
          onStart: () => {
            onReady();
            logServiceStarted(logger, process.pid);
          },
        }),
      stopPolling: () => bot.stop(),
      closeIngress: (stopPolling) => ingress.close(stopPolling),
      closeAgents: () => closeAgentsAndMemory(agentManager, memory, stateStore),
      closeOutbound: () => outbound.close(),
      closeDrafts: () => drafts?.close() ?? Promise.resolve(),
      closeActivity: () => activity.close(),
    });
  }

  static async create(
    config: AppConfig,
    logger: InfoLogger,
  ): Promise<BridgeApp> {
    await Promise.all([
      mkdir(config.paths.stateDir, { recursive: true }),
      mkdir(config.paths.sessionDir, { recursive: true }),
      mkdir(config.paths.attachmentsDir, { recursive: true }),
      mkdir(config.paths.workspaceDir, { recursive: true }),
      ...(config.memory.enabled
        ? [mkdir(config.paths.memoryDir, { recursive: true })]
        : []),
    ]);
    const stateStore = await StateStore.open(
      join(config.paths.stateDir, "state.json"),
    );
    const voiceTranscriber = TelegramVoiceTranscriber.create(
      config.stt,
      stateStore,
      config.paths.attachmentsDir,
    );
    const bot = new Bot(config.telegram.botToken, {
      client: { timeoutSeconds: 30 },
    });
    bot.api.config.use(createTelegramRetryTransformer());

    const downloader = new TelegramFileDownloader({
      api: {
        getFile: async (id, signal) => {
          const controller = new TelegramAbortController();
          const abort = (): void => controller.abort();
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
          try {
            return await bot.api.getFile(id, controller.signal);
          } finally {
            signal?.removeEventListener("abort", abort);
          }
        },
      },
      botToken: config.telegram.botToken,
      downloadsDir: config.paths.attachmentsDir,
      logger,
    });
    const activity = new TelegramActivityPresenter(bot.api, logger);
    const drafts = config.telegram.streamResponses
      ? new TelegramDraftStreamer(bot.api, logger)
      : undefined;
    const finalReplies = new TelegramFinalReplySender(
      bot.api,
      stateStore,
      logger,
    );
    const outbound = new TelegramOutboundSender({
      api: new Api(config.telegram.botToken),
      stateStore,
      rootDir: config.paths.workspaceDir,
      storageDir: join(config.paths.attachmentsDir, "outbound"),
      logger,
    });
    const status = new TelegramStatusSender(bot.api, logger);
    const memory = await MemoryRuntime.create(config, logger);
    const agentManager = new PiAgentManager({
      stateStore,
      workspaceDir: config.paths.workspaceDir,
      downloader,
      clientFactory: createPiRpcClientFactory({
        command: config.pi.command,
        cwd: config.paths.workspaceDir,
        args: config.pi.args,
        sessionDir: config.paths.sessionDir,
        logger,
      }),
      logger,
      callbacks: {
        onEvent: (chatId, event) => activity.handleEvent(chatId, event),
        ...(drafts
          ? {
              onTextStream: (chatId, event) => drafts.handle(chatId, event),
              onTextStreamFinish: (chatId, generation) =>
                drafts.finish(chatId, generation),
            }
          : {}),
        onFinalResponse: async (response) => {
          try {
            await finalReplies.send(response);
          } finally {
            await activity.finish(response.chatId);
          }
        },
        onCompactionStart: (chatId) => activity.startCompaction(chatId),
        onCompactionFinish: (chatId) => activity.finish(chatId),
        onTelegramOutbound: (request) => outbound.send(request),
        ...(memory
          ? {
              onMemoryRequest: (request) => memory.handleRequest(request),
              onSessionCheckpoint: (
                chatId: number,
                session: { id: string; file: string },
              ) =>
                memory.checkpointSession({
                  chatId,
                  sessionId: session.id,
                  sessionFile: session.file,
                }),
            }
          : {}),
        onSessionReset: async (chatId, replyToMessageId) => {
          await drafts?.abortChat(chatId);
          await activity.finish(chatId);
          await status.sessionReset(chatId, replyToMessageId);
        },
        onError: async (chatId, error, replyToMessageId) => {
          logger.info("pi_operation_failed", {
            chat_id: chatId,
            ...(replyToMessageId !== undefined
              ? { message_id: replyToMessageId }
              : {}),
            error_name: errorName(error),
            reason: "operation_failed",
          });
          await drafts?.abortChat(chatId).catch(() => undefined);
          await activity.finish(chatId).catch(() => undefined);
          if (replyToMessageId !== undefined) {
            await status
              .userError(chatId, replyToMessageId, publicPiError(error))
              .catch(() => undefined);
          }
        },
      },
    });

    const ingress = installTelegramIngress(bot, {
      ...(voiceTranscriber ? { voiceTranscriber } : {}),
      allowedUserIds: new Set(config.telegram.allowedUserIds),
      stateStore,
      downloader,
      handlers: {
        onMessage: (message) =>
          dispatchTelegramMessage(
            () => agentManager.submit(message),
            (error) =>
              reportIngressFailure(
                status,
                logger,
                message.updateId,
                message.chatId,
                message.messageId,
                "message_dispatch_failed",
                error,
              ),
          ),
        onNewSession: async (message) => {
          try {
            await agentManager.newSession(message.chatId, message.messageId);
            logger.info("telegram_command_result", {
              update_id: message.updateId,
              chat_id: message.chatId,
              message_id: message.messageId,
              command: "new",
              status: "succeeded",
            });
          } catch (error) {
            logger.info("telegram_command_result", {
              update_id: message.updateId,
              chat_id: message.chatId,
              message_id: message.messageId,
              command: "new",
              status: "failed",
            });
            await reportIngressFailure(
              status,
              logger,
              message.updateId,
              message.chatId,
              message.messageId,
              "new_session_dispatch_failed",
              error,
            );
          }
        },
        onCompact: async (message) => {
          try {
            const result = await agentManager.compact(message.chatId);
            await status.compaction(message.chatId, message.messageId, result);
            logger.info("telegram_command_result", {
              update_id: message.updateId,
              chat_id: message.chatId,
              message_id: message.messageId,
              command: "compact",
              status: "succeeded",
            });
          } catch (error) {
            logger.info("telegram_command_result", {
              update_id: message.updateId,
              chat_id: message.chatId,
              message_id: message.messageId,
              command: "compact",
              status: "failed",
            });
            await reportIngressFailure(
              status,
              logger,
              message.updateId,
              message.chatId,
              message.messageId,
              "compact_dispatch_failed",
              error,
            );
          }
        },
        onRestart: async (message) => {
          try {
            await agentManager.restart(message.chatId);
            await status.restarted(message.chatId, message.messageId);
            logger.info("telegram_command_result", {
              update_id: message.updateId,
              chat_id: message.chatId,
              message_id: message.messageId,
              command: "restart",
              status: "succeeded",
            });
          } catch (error) {
            logger.info("telegram_command_result", {
              update_id: message.updateId,
              chat_id: message.chatId,
              message_id: message.messageId,
              command: "restart",
              status: "failed",
            });
            await reportIngressFailure(
              status,
              logger,
              message.updateId,
              message.chatId,
              message.messageId,
              "restart_dispatch_failed",
              error,
            );
          }
        },
        onStatus: async (message) => {
          try {
            const current = await agentManager.status(message.chatId);
            await status.sessionStatus(
              message.chatId,
              message.messageId,
              current,
            );
            logger.info("telegram_command_result", {
              update_id: message.updateId,
              chat_id: message.chatId,
              message_id: message.messageId,
              command: "status",
              status: "succeeded",
            });
          } catch (error) {
            logger.info("telegram_command_result", {
              update_id: message.updateId,
              chat_id: message.chatId,
              message_id: message.messageId,
              command: "status",
              status: "failed",
            });
            await reportIngressFailure(
              status,
              logger,
              message.updateId,
              message.chatId,
              message.messageId,
              "status_dispatch_failed",
              error,
            );
          }
        },
        onStop: async (message) => {
          try {
            const didStop = await agentManager.stop(
              message.chatId,
              message.messageId,
            );
            await status.stopped(message.chatId, message.messageId, didStop);
            logger.info("telegram_command_result", {
              update_id: message.updateId,
              chat_id: message.chatId,
              message_id: message.messageId,
              command: "stop",
              status: "succeeded",
            });
          } catch (error) {
            logger.info("telegram_command_result", {
              update_id: message.updateId,
              chat_id: message.chatId,
              message_id: message.messageId,
              command: "stop",
              status: "failed",
            });
            await reportIngressFailure(
              status,
              logger,
              message.updateId,
              message.chatId,
              message.messageId,
              "stop_dispatch_failed",
              error,
            );
          }
        },
        onUserError: async (message, error) => {
          await ignoreTelegramStatusFailure(
            status.userError(
              message.chatId,
              message.messageId,
              ingressErrorMessage(error),
            ),
          );
        },
      },
      logger,
    });

    bot.catch((error) => rethrowTelegramUpdateFailure(logger, error));

    const app = new BridgeApp(
      bot,
      agentManager,
      ingress,
      activity,
      drafts,
      outbound,
      memory,
      stateStore,
      logger,
    );
    memory?.start();
    return app;
  }

  start(): Promise<void> {
    return this.#lifecycle.start();
  }

  stop(): Promise<void> {
    return this.#lifecycle.stop();
  }
}

export async function dispatchTelegramMessage(
  submit: () => Promise<void>,
  report: (error: unknown) => Promise<void>,
): Promise<void> {
  try {
    await submit();
  } catch (error) {
    await report(error).catch(() => undefined);
    throw error;
  }
}

async function reportIngressFailure(
  status: TelegramStatusSender,
  logger: InfoLogger,
  updateId: number,
  chatId: number,
  messageId: number,
  reason:
    | "message_dispatch_failed"
    | "new_session_dispatch_failed"
    | "status_dispatch_failed"
    | "stop_dispatch_failed"
    | "compact_dispatch_failed"
    | "restart_dispatch_failed",
  error: unknown,
): Promise<void> {
  logger.info("telegram_dispatch_failed", {
    update_id: updateId,
    chat_id: chatId,
    message_id: messageId,
    error_name: errorName(error),
    reason,
  });
  const normalized =
    error instanceof Error ? error : new Error("Unknown ingress failure");
  await ignoreTelegramStatusFailure(
    status.userError(chatId, messageId, publicPiError(normalized)),
  );
}

export async function ignoreTelegramStatusFailure(
  operation: Promise<void>,
): Promise<void> {
  await operation.catch(() => undefined);
}

export function rethrowTelegramUpdateFailure(
  logger: InfoLogger,
  failure: {
    ctx: { update: { update_id: number } };
    error: unknown;
  },
): never {
  logger.info("telegram_update_failed", {
    update_id: failure.ctx.update.update_id,
    error_name: errorName(failure.error),
    reason: "update_handler_failed",
  });
  throw failure;
}

function ingressErrorMessage(error: TelegramIngressError): string {
  return error.message;
}

export async function closeAgentsAndMemory(
  agentManager: Pick<PiAgentManager, "close">,
  memory: Pick<MemoryRuntime, "beginShutdown" | "close"> | undefined,
  stateStore: Pick<StateStore, "snapshot">,
): Promise<void> {
  const memoryBeginResult = memory
    ? await Promise.allSettled([memory.beginShutdown()])
    : [];
  const agentResult = await Promise.allSettled([agentManager.close()]);
  const memoryResult = memory
    ? await Promise.allSettled([memory.close(stateStore.snapshot())])
    : [];
  const failures = [...memoryBeginResult, ...agentResult, ...memoryResult]
    .filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, "Agent or memory close was incomplete");
  }
}

export function publicPiError(error: Error): string {
  if (error instanceof UnresolvableTelegramReplyError) {
    return "无法读取被回复的 Telegram 消息，本条消息未提交给助手。请重新发送或转发原消息内容。";
  }
  if (error.message.includes("取消了新建 session")) {
    return "无法开始新会话：操作已取消。";
  }
  if (error.message.includes("session 不匹配")) {
    return "无法恢复会话。请检查服务端会话文件。";
  }
  return "消息处理失败。请检查服务日志后重试。";
}
