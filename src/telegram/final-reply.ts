import type { PiFinalResponse } from "../bridge/agent-manager";
import { errorName, noopInfoLogger, type InfoLogger } from "../logging/logger";
import { telegramTimestamp } from "./time";
import { getOrCreateChatState, indexMessage, type StateStore } from "../state";
import { splitTelegramMarkdown, type TelegramMarkdownChunk } from "./markdown";

export interface TelegramSentMessage {
  message_id: number;
  date: number;
}

export interface TelegramReplyApi {
  sendMessage(
    chatId: number,
    text: string,
    options?: {
      parse_mode?: "MarkdownV2";
      reply_parameters?: {
        message_id: number;
        allow_sending_without_reply: boolean;
      };
      disable_notification?: boolean;
    },
  ): Promise<TelegramSentMessage>;
}

export class TelegramFinalReplySender {
  readonly #api: TelegramReplyApi;
  readonly #stateStore: StateStore;
  readonly #logger: InfoLogger;

  constructor(
    api: TelegramReplyApi,
    stateStore: StateStore,
    logger: InfoLogger = noopInfoLogger,
  ) {
    this.#api = api;
    this.#stateStore = stateStore;
    this.#logger = logger;
  }

  async send(response: PiFinalResponse): Promise<void> {
    const startedAt = Date.now();
    const chunks = splitTelegramMarkdown(response.text);
    let fallbackCount = 0;
    for (const [index, chunk] of chunks.entries()) {
      if (!isResponseCurrent(response)) {
        return;
      }
      const replyParameters =
        index === 0
          ? {
              message_id: response.replyToMessageId,
              allow_sending_without_reply: true,
            }
          : undefined;
      const result = await this.#sendChunk(
        response.chatId,
        response.replyToMessageId,
        chunk,
        replyParameters,
        index,
        chunks.length,
      );
      fallbackCount += result.usedFallback ? 1 : 0;
      try {
        await this.#stateStore.update((state) => {
          indexMessage(getOrCreateChatState(state, response.chatId), {
            messageId: result.message.message_id,
            role: "assistant",
            piSessionId: response.sessionId,
            piEntryId: response.piEntryId,
            sentAt: telegramTimestamp(result.message.date),
            text: chunk.source,
            attachments: [],
          });
        });
      } catch (error) {
        this.#logReplyFailure(
          response.chatId,
          response.replyToMessageId,
          index + 1,
          chunks.length,
          "state_persist_failed",
          error,
        );
        throw error;
      }
    }
    this.#logger.info("telegram_reply_sent", {
      chat_id: response.chatId,
      reply_to_message_id: response.replyToMessageId,
      chunks_sent: chunks.length,
      fallback_count: fallbackCount,
      duration_ms: Date.now() - startedAt,
    });
  }

  async #sendChunk(
    chatId: number,
    replyToMessageId: number,
    chunk: TelegramMarkdownChunk,
    replyParameters:
      { message_id: number; allow_sending_without_reply: boolean } | undefined,
    chunksSent: number,
    chunksTotal: number,
  ): Promise<{ message: TelegramSentMessage; usedFallback: boolean }> {
    try {
      return {
        message: await this.#api.sendMessage(chatId, chunk.markdownV2, {
          parse_mode: "MarkdownV2",
          ...(replyParameters ? { reply_parameters: replyParameters } : {}),
        }),
        usedFallback: false,
      };
    } catch (error) {
      if (!isMarkdownParseError(error)) {
        this.#logReplyFailure(
          chatId,
          replyToMessageId,
          chunksSent,
          chunksTotal,
          "markdown_send_failed",
          error,
        );
        throw error;
      }
      try {
        return {
          message: await this.#api.sendMessage(chatId, chunk.source, {
            ...(replyParameters ? { reply_parameters: replyParameters } : {}),
          }),
          usedFallback: true,
        };
      } catch (fallbackError) {
        this.#logReplyFailure(
          chatId,
          replyToMessageId,
          chunksSent,
          chunksTotal,
          "plain_send_failed",
          fallbackError,
        );
        throw fallbackError;
      }
    }
  }

  #logReplyFailure(
    chatId: number,
    replyToMessageId: number,
    chunksSent: number,
    chunksTotal: number,
    reason:
      "markdown_send_failed" | "plain_send_failed" | "state_persist_failed",
    error: unknown,
  ): void {
    this.#logger.info("telegram_reply_failed", {
      chat_id: chatId,
      reply_to_message_id: replyToMessageId,
      chunks_sent: chunksSent,
      chunks_total: chunksTotal,
      error_name: errorName(error),
      reason,
    });
  }
}

function isResponseCurrent(response: PiFinalResponse): boolean {
  return !response.signal?.aborted && (response.isCurrent?.() ?? true);
}

function isMarkdownParseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("can't parse entities") ||
    normalized.includes("can't find end of") ||
    normalized.includes("entity bounds")
  );
}
