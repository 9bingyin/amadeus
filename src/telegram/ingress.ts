import type { Bot, Context, NextFunction } from "grammy";
import type { InfoLogger } from "../logging/logger";
import type {
  AttachmentDownloader,
  NormalizedTelegramMessage,
  TelegramAttachment,
  TelegramContentKind,
  TelegramMessageContent,
} from "./types";
import {
  getOrCreateChatState,
  hasSeenMessage,
  markMessageSeen,
  type StateStore,
} from "../state";
import { markTelegramAttachmentUnavailable } from "./download";
import { normalizeTelegramMessage } from "./normalize";
import type { VoiceTranscriber } from "../stt/transcriber";

export type TelegramIngressError = {
  code: "unsupported";
  message: string;
};

export interface TelegramControlMessage {
  updateId: number;
  chatId: number;
  messageId: number;
}

export interface TelegramIngressHandlers {
  onMessage(message: NormalizedTelegramMessage): Promise<void>;
  onNewSession(message: TelegramControlMessage): Promise<void>;
  onCompact(message: TelegramControlMessage): Promise<void>;
  onRestart(message: TelegramControlMessage): Promise<void>;
  onStatus(message: TelegramControlMessage): Promise<void>;
  onStop(message: TelegramControlMessage): Promise<void>;
  onUserError(
    message: TelegramControlMessage,
    error: TelegramIngressError,
  ): Promise<void>;
}

export interface TelegramIngressController {
  close(stopPolling: () => Promise<void>): Promise<void>;
}

export interface TelegramIngressOptions {
  allowedUserIds: ReadonlySet<number>;
  stateStore: StateStore;
  downloader: AttachmentDownloader;
  handlers: TelegramIngressHandlers;
  voiceTranscriber?: VoiceTranscriber;
  logger: InfoLogger;
}

export function installTelegramIngress<C extends Context>(
  bot: Bot<C>,
  options: TelegramIngressOptions,
): TelegramIngressController {
  const controlTasks = new Set<Promise<void>>();
  let closing = false;
  let activeUpdates = 0;
  let activeUpdateFailed = false;
  let closeTask: Promise<void> | undefined;
  let stopPollingTask: Promise<void> | undefined;
  let resolveActiveUpdates: (() => void) | undefined;
  let stopPolling: (() => Promise<void>) | undefined;
  const launchControlHandler = (operation: () => Promise<void>): void => {
    if (closing) {
      return;
    }
    const task = operation().catch(() => undefined);
    controlTasks.add(task);
    void task.finally(() => controlTasks.delete(task)).catch(() => undefined);
  };

  const processUpdate = async (ctx: C, next: NextFunction): Promise<void> => {
    const lastUpdateId = options.stateStore.snapshot().lastUpdateId;
    if (lastUpdateId !== undefined && ctx.update.update_id <= lastUpdateId) {
      options.logger.info("telegram_update_ignored", {
        update_id: ctx.update.update_id,
        reason: "stale_update",
      });
      return;
    }

    if (ctx.chat?.type !== "private") {
      options.logger.info("telegram_update_ignored", {
        update_id: ctx.update.update_id,
        reason: "non_private_chat",
      });
      await markUpdateProcessed(options.stateStore, ctx.update.update_id);
      return;
    }

    if (ctx.from === undefined || !options.allowedUserIds.has(ctx.from.id)) {
      options.logger.info("telegram_update_ignored", {
        update_id: ctx.update.update_id,
        reason: "disallowed_user",
      });
      await markUpdateProcessed(options.stateStore, ctx.update.update_id);
      return;
    }

    const messageId = ctx.msg?.message_id;
    if (
      messageId !== undefined &&
      hasSeenMessage(
        options.stateStore.snapshot().chats[String(ctx.chat.id)],
        messageId,
      )
    ) {
      options.logger.info("telegram_update_ignored", {
        update_id: ctx.update.update_id,
        reason: "duplicate_message",
      });
      await markUpdateProcessed(options.stateStore, ctx.update.update_id);
      return;
    }

    await next();
    await markUpdateProcessed(
      options.stateStore,
      ctx.update.update_id,
      messageId === undefined ? undefined : { chatId: ctx.chat.id, messageId },
    );
  };

  bot.use(async (ctx, next) => {
    if (closing) {
      options.logger.info("telegram_update_ignored", {
        update_id: ctx.update.update_id,
        reason: "service_stopping",
      });
      return;
    }

    activeUpdates += 1;
    let succeeded = false;
    try {
      await processUpdate(ctx, next);
      succeeded = true;
    } finally {
      activeUpdateFailed ||= !succeeded;
      activeUpdates -= 1;
      if (closing && activeUpdates === 0) {
        if (!activeUpdateFailed) {
          startPollingStop();
        }
        resolveActiveUpdates?.();
        resolveActiveUpdates = undefined;
      }
    }
  });

  bot.command("new", (ctx) => {
    const message = commandMessage(ctx);
    options.logger.info("telegram_command_accepted", {
      update_id: message.updateId,
      chat_id: message.chatId,
      message_id: message.messageId,
      command: "new",
    });
    launchControlHandler(() => options.handlers.onNewSession(message));
  });

  bot.command("compact", (ctx) => {
    const message = commandMessage(ctx);
    options.logger.info("telegram_command_accepted", {
      update_id: message.updateId,
      chat_id: message.chatId,
      message_id: message.messageId,
      command: "compact",
    });
    launchControlHandler(() => options.handlers.onCompact(message));
  });

  bot.command("restart", (ctx) => {
    const message = commandMessage(ctx);
    options.logger.info("telegram_command_accepted", {
      update_id: message.updateId,
      chat_id: message.chatId,
      message_id: message.messageId,
      command: "restart",
    });
    launchControlHandler(() => options.handlers.onRestart(message));
  });

  bot.command("status", (ctx) => {
    const message = commandMessage(ctx);
    options.logger.info("telegram_command_accepted", {
      update_id: message.updateId,
      chat_id: message.chatId,
      message_id: message.messageId,
      command: "status",
    });
    launchControlHandler(() => options.handlers.onStatus(message));
  });

  bot.command("stop", (ctx) => {
    const message = commandMessage(ctx);
    options.logger.info("telegram_command_accepted", {
      update_id: message.updateId,
      chat_id: message.chatId,
      message_id: message.messageId,
      command: "stop",
    });
    launchControlHandler(() => options.handlers.onStop(message));
  });

  bot.on("message", async (ctx) => {
    const control = {
      updateId: ctx.update.update_id,
      chatId: ctx.chat.id,
      messageId: ctx.msg.message_id,
    } satisfies TelegramControlMessage;
    const normalized = normalizeTelegramMessage(ctx.update.update_id, ctx.msg);

    if (normalized.status === "unsupported") {
      options.logger.info("telegram_input_rejected", {
        update_id: control.updateId,
        chat_id: control.chatId,
        message_id: control.messageId,
        reason: normalized.code,
      });
      await options.handlers.onUserError(control, {
        code: "unsupported",
        message: normalized.reason,
      });
      return;
    }

    const attachments = await downloadCurrentAttachments(
      normalized.message.attachments,
      normalized.message.chatId,
      normalized.message.messageId,
      options.downloader,
    );
    if (options.voiceTranscriber) {
      for (const attachment of attachments) {
        if (attachment.kind === "voice") {
          attachment.transcription = await options.voiceTranscriber.transcribe(
            attachment,
            normalized.message.chatId,
            normalized.message.messageId,
          );
        }
      }
    }
    const message = { ...normalized.message, attachments };
    options.logger.info("telegram_message_accepted", {
      update_id: message.updateId,
      chat_id: message.chatId,
      message_id: message.messageId,
      attachment_count: attachments.length,
      photo_count: countAttachments(attachments, "photo"),
      document_count: countAttachments(attachments, "document"),
      has_forward: message.forward !== undefined,
      has_reply: message.reply !== undefined,
      has_quote: message.reply?.quote !== undefined,
      message_type: telegramMessageType(message.content, attachments),
    });
    await options.handlers.onMessage(message);
  });

  const startPollingStop = (): void => {
    if (stopPollingTask || !stopPolling) {
      return;
    }
    try {
      stopPollingTask = stopPolling();
    } catch (error) {
      stopPollingTask = Promise.reject(error);
    }
    void stopPollingTask.catch(() => undefined);
  };

  return {
    close(stop): Promise<void> {
      if (closeTask) {
        return closeTask;
      }
      closing = true;
      stopPolling = stop;
      closeTask = (async () => {
        if (activeUpdates === 0) {
          startPollingStop();
        } else {
          await new Promise<void>((resolve) => {
            resolveActiveUpdates = resolve;
          });
        }
        const [stopResult] = await Promise.allSettled([
          stopPollingTask ?? Promise.resolve(),
        ]);
        while (controlTasks.size > 0) {
          await Promise.allSettled(controlTasks);
        }
        await options.voiceTranscriber?.close();
        if (stopResult?.status === "rejected") {
          throw stopResult.reason;
        }
      })();
      return closeTask;
    },
  };
}

function commandMessage(ctx: Context): TelegramControlMessage {
  if (!ctx.chat || !ctx.msg) {
    throw new Error("Telegram 命令缺少 chat 或 message");
  }
  return {
    updateId: ctx.update.update_id,
    chatId: ctx.chat.id,
    messageId: ctx.msg.message_id,
  };
}

function telegramMessageType(
  content: TelegramMessageContent | undefined,
  attachments: readonly TelegramAttachment[],
): TelegramContentKind | "mixed" {
  if (content) {
    return content.kind === "unavailable" ? content.contentKind : content.kind;
  }
  if (attachments.length === 0) {
    return "text";
  }
  const kinds = new Set(attachments.map((attachment) => attachment.kind));
  if (kinds.size > 1) {
    return "mixed";
  }
  return attachments[0]?.kind ?? "text";
}

function countAttachments(
  attachments: readonly TelegramAttachment[],
  kind: TelegramAttachment["kind"],
): number {
  return attachments.filter((attachment) => attachment.kind === kind).length;
}

async function downloadCurrentAttachments(
  attachments: readonly TelegramAttachment[],
  chatId: number,
  messageId: number,
  downloader: AttachmentDownloader,
): Promise<TelegramAttachment[]> {
  const downloaded: TelegramAttachment[] = [];
  for (const attachment of attachments) {
    try {
      downloaded.push(await downloader.download(attachment, chatId, messageId));
    } catch (error) {
      downloaded.push(markTelegramAttachmentUnavailable(attachment, error));
    }
  }
  return downloaded;
}

async function markUpdateProcessed(
  stateStore: StateStore,
  updateId: number,
  message?: { chatId: number; messageId: number },
): Promise<void> {
  await stateStore.update((state) => {
    if (state.lastUpdateId === undefined || updateId > state.lastUpdateId) {
      state.lastUpdateId = updateId;
    }
    if (message) {
      markMessageSeen(
        getOrCreateChatState(state, message.chatId),
        message.messageId,
      );
    }
  });
}
