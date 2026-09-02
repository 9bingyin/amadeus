import { describe, expect, test } from "bun:test";
import {
  formatSessionStatus,
  TelegramStatusSender,
  type TelegramStatusApi,
} from "../../src/telegram/status";

describe("TelegramStatusSender", () => {
  test("新会话提示与命令描述一致", async () => {
    const calls: Array<{
      chatId: number;
      text: string;
      options: Parameters<TelegramStatusApi["sendMessage"]>[2];
    }> = [];
    const api: TelegramStatusApi = {
      async sendMessage(chatId, text, options) {
        calls.push({ chatId, text, options });
        return {};
      },
    };

    await new TelegramStatusSender(api).sessionReset(10, 20);

    expect(calls).toEqual([
      {
        chatId: 10,
        text: "已开始新会话。",
        options: {
          reply_parameters: {
            message_id: 20,
            allow_sending_without_reply: true,
          },
        },
      },
    ]);
  });

  test("使用简短的重启提示", async () => {
    const texts: string[] = [];
    const api: TelegramStatusApi = {
      async sendMessage(_chatId, text) {
        texts.push(text);
        return {};
      },
    };

    await new TelegramStatusSender(api).restarted(10, 20);

    expect(texts).toEqual(["会话已重启。"]);
  });

  test("显示上下文压缩结果和忙碌提示", async () => {
    const texts: string[] = [];
    const api: TelegramStatusApi = {
      async sendMessage(_chatId, text) {
        texts.push(text);
        return {};
      },
    };
    const sender = new TelegramStatusSender(api);

    await sender.compaction(10, 20, {
      status: "compacted",
      tokensBefore: 150_000,
      estimatedTokensAfter: 32_000,
    });
    await sender.compaction(10, 21, { status: "busy" });
    await sender.compaction(10, 22, { status: "cancelled" });
    await sender.compaction(10, 23, { status: "not_needed" });

    expect(texts).toEqual([
      "已压缩会话上下文。",
      "当前正在处理请求，请先使用 /stop。",
      "已取消上下文压缩。",
      "当前上下文较小，无需压缩。",
    ]);
  });

  test("区分已停止和当前空闲", async () => {
    const texts: string[] = [];
    const api: TelegramStatusApi = {
      async sendMessage(_chatId, text) {
        texts.push(text);
        return {};
      },
    };
    const sender = new TelegramStatusSender(api);

    await sender.stopped(10, 20, true);
    await sender.stopped(10, 21, false);

    expect(texts).toEqual(["已停止当前处理。", "当前没有正在处理的请求。"]);
  });

  test("显示工作目录、模型和上下文占用", () => {
    expect(
      formatSessionStatus({
        sessionId: "session-123",
        workspaceDir: "/home/user/.amadeus/workspace",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        thinkingLevel: "high",
        contextUsage: {
          tokens: 182_024,
          contextWindow: 200_000,
          percent: 91.012,
        },
      }),
    ).toBe(
      [
        "会话 ID：session-123",
        "工作目录：/home/user/.amadeus/workspace",
        "提供商：openai-codex",
        "模型：gpt-5.6-sol",
        "思考强度：high",
        "上下文：182,024 / 200,000 tokens（91%）",
      ].join("\n"),
    );
  });

  test("状态数据尚不可用时显示明确占位", () => {
    expect(
      formatSessionStatus({
        sessionId: "session-empty",
        provider: null,
        model: null,
        thinkingLevel: null,
        contextUsage: undefined,
      }),
    ).toBe(
      [
        "会话 ID：session-empty",
        "工作目录：未知",
        "提供商：未配置",
        "模型：未配置",
        "思考强度：未知",
        "上下文：不可用",
      ].join("\n"),
    );
  });
});
