import { afterEach, describe, expect, test } from "bun:test";
import { AbortController } from "abort-controller";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../../src/state";
import {
  TelegramFinalReplySender,
  type TelegramReplyApi,
} from "../../src/telegram/final-reply";
import { RecordingLogger } from "../helpers/recording-logger";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("TelegramFinalReplySender", () => {
  test("只让首段 reply 用户消息，并索引每条 assistant 消息", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-output-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const calls: Array<{ text: string; options: unknown }> = [];
    let messageId = 100;
    const api: TelegramReplyApi = {
      sendMessage: async (_chatId, text, options) => {
        calls.push({ text, options });
        messageId += 1;
        return { message_id: messageId, date: 1788279056 };
      },
    };
    const logger = new RecordingLogger();
    const sender = new TelegramFinalReplySender(api, stateStore, logger);

    await sender.send({
      chatId: 1,
      replyToMessageId: 50,
      sessionId: "session",
      piEntryId: "assistant-entry-1",
      text: "段落。\n\n".repeat(1000),
      stopReason: "stop",
    });

    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0]?.options).toMatchObject({
      parse_mode: "MarkdownV2",
      reply_parameters: { message_id: 50 },
    });
    expect(calls[1]?.options).not.toHaveProperty("reply_parameters");
    const indexed = Object.values(
      stateStore.snapshot().chats["1"]?.messages ?? {},
    );
    expect(indexed).toHaveLength(calls.length);
    expect(
      indexed.every((message) => message.piEntryId === "assistant-entry-1"),
    ).toBe(true);
    expect(logger.events()).toEqual(["telegram_reply_sent"]);
    expect(logger.entries[0]).toMatchObject({
      fields: {
        chat_id: 1,
        chunks_sent: calls.length,
        fallback_count: 0,
        reply_to_message_id: 50,
      },
    });
  });

  test("停止后不再发送剩余回复分段", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-output-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const controller = new AbortController();
    let releaseFirstSend: (() => void) | undefined;
    const calls: string[] = [];
    const api: TelegramReplyApi = {
      async sendMessage(_chatId, text) {
        calls.push(text);
        if (calls.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstSend = resolve;
          });
        }
        return { message_id: 100 + calls.length, date: 1788279056 };
      },
    };
    const sending = new TelegramFinalReplySender(api, stateStore).send({
      chatId: 1,
      replyToMessageId: 50,
      sessionId: "session",
      piEntryId: "assistant-entry-1",
      text: "段落。\n\n".repeat(1000),
      stopReason: "stop",
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted,
    });

    await waitFor(() => calls.length === 1);
    controller.abort();
    releaseFirstSend?.();
    await sending;

    expect(calls).toHaveLength(1);
  });

  test("停止发生在 Markdown 解析失败期间时仍完成当前分段降级", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-output-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const controller = new AbortController();
    let releaseMarkdown: (() => void) | undefined;
    const texts: string[] = [];
    const api: TelegramReplyApi = {
      async sendMessage(_chatId, text, options) {
        texts.push(text);
        if (options?.parse_mode) {
          await new Promise<void>((resolve) => {
            releaseMarkdown = resolve;
          });
          throw new Error("400: Bad Request: can't parse entities");
        }
        return { message_id: 101, date: 1788279056 };
      },
    };
    const sending = new TelegramFinalReplySender(api, stateStore).send({
      chatId: 1,
      replyToMessageId: 50,
      sessionId: "session",
      piEntryId: "assistant-entry-1",
      text: "**bold** + plain",
      stopReason: "stop",
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted,
    });

    await waitFor(() => texts.length === 1);
    controller.abort();
    releaseMarkdown?.();
    await sending;

    expect(texts).toEqual(["*bold* \\+ plain", "**bold** + plain"]);
    expect(stateStore.snapshot().chats["1"]?.messageOrder).toEqual([101]);
  });

  test("Telegram 网络失败不会误用纯文本重发", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-output-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    let calls = 0;
    const api: TelegramReplyApi = {
      sendMessage: async () => {
        calls += 1;
        throw new Error("network unavailable");
      },
    };

    const logger = new RecordingLogger();
    const operation = new TelegramFinalReplySender(
      api,
      stateStore,
      logger,
    ).send({
      chatId: 1,
      replyToMessageId: 50,
      sessionId: "session",
      piEntryId: "assistant-entry-1",
      text: "reply",
      stopReason: "stop",
    });

    await expect(operation).rejects.toThrow("network unavailable");
    expect(calls).toBe(1);
    expect(logger.entries).toEqual([
      {
        event: "telegram_reply_failed",
        fields: {
          chat_id: 1,
          reply_to_message_id: 50,
          chunks_sent: 0,
          chunks_total: 1,
          error_name: "Error",
          reason: "markdown_send_failed",
        },
      },
    ]);
  });

  test("仅在 MarkdownV2 实体解析失败时降级纯文本", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-output-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const texts: string[] = [];
    const api: TelegramReplyApi = {
      sendMessage: async (_chatId, text, options) => {
        texts.push(text);
        if (options?.parse_mode) {
          throw new Error("400: Bad Request: can't parse entities");
        }
        return { message_id: 101, date: 1788279056 };
      },
    };

    const logger = new RecordingLogger();
    await new TelegramFinalReplySender(api, stateStore, logger).send({
      chatId: 1,
      replyToMessageId: 50,
      sessionId: "session",
      piEntryId: "assistant-entry-1",
      text: "**bold** + plain",
      stopReason: "stop",
    });

    expect(texts).toEqual(["*bold* \\+ plain", "**bold** + plain"]);
    expect(logger.entries[0]).toMatchObject({
      event: "telegram_reply_sent",
      fields: { fallback_count: 1 },
    });
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("等待测试条件超时");
}
