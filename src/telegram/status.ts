import type { PiChatStatus, PiCompactionResult } from "../bridge/agent-manager";
import { errorName, noopInfoLogger, type InfoLogger } from "../logging/logger";

export interface TelegramStatusApi {
  sendMessage(
    chatId: number,
    text: string,
    options?: {
      reply_parameters?: {
        message_id: number;
        allow_sending_without_reply: boolean;
      };
    },
  ): Promise<unknown>;
}

export class TelegramStatusSender {
  readonly #api: TelegramStatusApi;
  readonly #logger: InfoLogger;

  constructor(api: TelegramStatusApi, logger: InfoLogger = noopInfoLogger) {
    this.#api = api;
    this.#logger = logger;
  }

  async sessionReset(chatId: number, replyToMessageId: number): Promise<void> {
    await this.#reply(chatId, replyToMessageId, "已开始新会话。");
  }

  async restarted(chatId: number, replyToMessageId: number): Promise<void> {
    await this.#reply(chatId, replyToMessageId, "会话已重启。");
  }

  async compaction(
    chatId: number,
    replyToMessageId: number,
    result: PiCompactionResult,
  ): Promise<void> {
    const text =
      result.status === "busy"
        ? "当前正在处理请求，请先使用 /stop。"
        : result.status === "cancelled"
          ? "已取消上下文压缩。"
          : result.status === "not_needed"
            ? "当前上下文较小，无需压缩。"
            : "已压缩会话上下文。";
    await this.#reply(chatId, replyToMessageId, text);
  }

  async stopped(
    chatId: number,
    replyToMessageId: number,
    didStop: boolean,
  ): Promise<void> {
    await this.#reply(
      chatId,
      replyToMessageId,
      didStop ? "已停止当前处理。" : "当前没有正在处理的请求。",
    );
  }

  async sessionStatus(
    chatId: number,
    replyToMessageId: number,
    status: PiChatStatus,
  ): Promise<void> {
    await this.#reply(chatId, replyToMessageId, formatSessionStatus(status));
  }

  async userError(
    chatId: number,
    replyToMessageId: number,
    message: string,
  ): Promise<void> {
    await this.#reply(chatId, replyToMessageId, message);
  }

  async #reply(
    chatId: number,
    replyToMessageId: number,
    text: string,
  ): Promise<void> {
    try {
      await this.#api.sendMessage(chatId, text, {
        reply_parameters: {
          message_id: replyToMessageId,
          allow_sending_without_reply: true,
        },
      });
    } catch (error) {
      this.#logger.info("telegram_status_failed", {
        chat_id: chatId,
        message_id: replyToMessageId,
        error_name: errorName(error),
        reason: "status_send_failed",
      });
      throw error;
    }
  }
}

export function formatSessionStatus(status: PiChatStatus): string {
  return [
    `会话 ID：${status.sessionId}`,
    `工作目录：${status.workspaceDir ?? "未知"}`,
    `提供商：${status.provider ?? "未配置"}`,
    `模型：${status.model ?? "未配置"}`,
    `思考强度：${status.thinkingLevel ?? "未知"}`,
    `上下文：${formatContextUsage(status.contextUsage)}`,
  ].join("\n");
}

function formatContextUsage(usage: PiChatStatus["contextUsage"]): string {
  if (!usage) {
    return "不可用";
  }
  const tokens =
    usage.tokens === null ? "暂无数据" : formatInteger(usage.tokens);
  const percent =
    usage.percent === null ? "暂无数据" : `${formatPercent(usage.percent)}%`;
  return `${tokens} / ${formatInteger(usage.contextWindow)} tokens（${percent}）`;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(
    value,
  );
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(
    value,
  );
}
