import type { AbortSignal } from "abort-controller";
import { describe, expect, test } from "bun:test";
import {
  draftPreview,
  TelegramDraftStreamer,
  type TelegramDraftApi,
} from "../../src/telegram/streaming";
import { RecordingLogger } from "../helpers/recording-logger";

describe("TelegramDraftStreamer", () => {
  test("只在积累到可见文本后发送首个原生 draft", async () => {
    const calls: Array<{ chatId: number; draftId: number; text: string }> = [];
    const api: TelegramDraftApi = {
      sendMessageDraft: async (chatId, draftId, text) => {
        calls.push({ chatId, draftId, text });
        return true;
      },
    };
    const streamer = new TelegramDraftStreamer(api, undefined, {
      intervalMs: 5,
      draftId: 1,
    });
    const generation = { revision: 1, segment: 1 };

    streamer.handle(10, {
      type: "start",
      generation,
      replyToMessageId: 50,
    });
    await Bun.sleep(8);
    expect(calls).toEqual([]);

    streamer.handle(10, { type: "delta", generation, text: "hel" });
    await Bun.sleep(8);
    expect(calls).toEqual([]);

    streamer.handle(10, { type: "delta", generation, text: "lo world" });
    await waitFor(() => calls.some((call) => call.text === "hello world"));
    await streamer.finish(10, generation);

    expect(calls[0]).toEqual({
      chatId: 10,
      draftId: 1,
      text: "hello world",
    });
  });

  test("首帧门槛按 Unicode 字符而不是 UTF-16 单元计算", async () => {
    const texts: string[] = [];
    const streamer = new TelegramDraftStreamer(
      {
        sendMessageDraft: async (_chatId, _draftId, text) => {
          texts.push(text);
          return true;
        },
      },
      undefined,
      { intervalMs: 1 },
    );
    const generation = { revision: 1, segment: 1 };
    streamer.handle(1, {
      type: "start",
      generation,
      replyToMessageId: 10,
    });
    streamer.handle(1, { type: "delta", generation, text: "😀😀" });
    await Bun.sleep(4);
    expect(texts).toEqual([]);

    streamer.handle(1, { type: "delta", generation, text: "😀😀" });
    await waitFor(() => texts.length === 1);
    await streamer.finish(1, generation);

    expect(texts).toEqual(["😀😀😀😀"]);
  });

  test("普通回复在首帧延迟内完成时仍发送最终 draft", async () => {
    const texts: string[] = [];
    const streamer = new TelegramDraftStreamer(
      {
        sendMessageDraft: async (_chatId, _draftId, text) => {
          texts.push(text);
          return true;
        },
      },
      undefined,
      { intervalMs: 20 },
    );
    const generation = { revision: 1, segment: 1 };

    streamer.handle(1, {
      type: "start",
      generation,
      replyToMessageId: 10,
    });
    streamer.handle(1, {
      type: "delta",
      generation,
      text: "quick response",
    });
    await streamer.finish(1, generation);

    expect(texts).toEqual(["quick response"]);
  });

  test("工具边界前结束的短暂文本不会创建 Telegram draft", async () => {
    const texts: string[] = [];
    const streamer = new TelegramDraftStreamer(
      {
        sendMessageDraft: async (_chatId, _draftId, text) => {
          texts.push(text);
          return true;
        },
      },
      undefined,
      { intervalMs: 20 },
    );
    const generation = { revision: 1, segment: 1 };

    streamer.handle(1, {
      type: "start",
      generation,
      replyToMessageId: 10,
    });
    await Bun.sleep(25);
    streamer.handle(1, { type: "delta", generation, text: "checking" });
    await Bun.sleep(2);
    streamer.handle(1, { type: "abort", generation });
    await Bun.sleep(25);

    expect(texts).toEqual([]);
  });

  test("不同 generation 使用不同 draft ID", async () => {
    const draftIds: number[] = [];
    const streamer = new TelegramDraftStreamer(
      {
        sendMessageDraft: async (_chatId, draftId) => {
          draftIds.push(draftId);
          return true;
        },
      },
      undefined,
      { intervalMs: 1, draftId: 1 },
    );
    const first = { revision: 1, segment: 1 };
    const second = { revision: 2, segment: 2 };

    streamer.handle(1, {
      type: "start",
      generation: first,
      replyToMessageId: 10,
    });
    streamer.handle(1, { type: "delta", generation: first, text: "first" });
    await waitFor(() => draftIds.length === 1);
    await streamer.finish(1, first);

    streamer.handle(1, {
      type: "start",
      generation: second,
      replyToMessageId: 11,
    });
    streamer.handle(1, {
      type: "delta",
      generation: second,
      text: "second",
    });
    await waitFor(() => draftIds.length === 2);
    await streamer.finish(1, second);

    expect(draftIds).toEqual([1, 2]);
  });

  test("API 请求变慢时跳过中间草稿快照", async () => {
    const texts: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstRequest = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const streamer = new TelegramDraftStreamer(
      {
        sendMessageDraft: async (_chatId, _draftId, text) => {
          texts.push(text);
          if (texts.length === 1) {
            await firstRequest;
          }
          return true;
        },
      },
      undefined,
      { intervalMs: 1 },
    );
    const generation = { revision: 1, segment: 1 };

    streamer.handle(1, {
      type: "start",
      generation,
      replyToMessageId: 10,
    });
    streamer.handle(1, { type: "delta", generation, text: "abcd" });
    await waitFor(() => texts.length === 1);
    streamer.handle(1, { type: "delta", generation, text: "e" });
    streamer.handle(1, { type: "delta", generation, text: "f" });
    releaseFirst?.();

    await waitFor(() => texts.includes("abcdef"));
    await streamer.finish(1, generation);

    expect(texts).toEqual(["abcd", "abcdef"]);
  });

  test("忽略旧 generation 的晚到增量", async () => {
    const texts: string[] = [];
    const streamer = new TelegramDraftStreamer(
      {
        sendMessageDraft: async (_chatId, _draftId, text) => {
          texts.push(text);
          return true;
        },
      },
      undefined,
      { intervalMs: 1 },
    );
    const oldGeneration = { revision: 1, segment: 1 };
    const currentGeneration = { revision: 2, segment: 2 };

    streamer.handle(1, {
      type: "start",
      generation: oldGeneration,
      replyToMessageId: 10,
    });
    streamer.handle(1, {
      type: "start",
      generation: currentGeneration,
      replyToMessageId: 11,
    });
    streamer.handle(1, {
      type: "delta",
      generation: oldGeneration,
      text: "stale",
    });
    streamer.handle(1, {
      type: "delta",
      generation: currentGeneration,
      text: "current",
    });

    await waitFor(() => texts.includes("current"));
    await streamer.finish(1, currentGeneration);

    expect(texts).not.toContain("stale");
  });

  test("abort 会取消已经在途的 draft 请求", async () => {
    let requestSignal: AbortSignal | undefined;
    const streamer = new TelegramDraftStreamer(
      {
        sendMessageDraft: async (_chatId, _draftId, _text, _other, signal) => {
          requestSignal = signal;
          return new Promise<true>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          });
        },
      },
      undefined,
      { intervalMs: 1 },
    );
    const generation = { revision: 1, segment: 1 };
    streamer.handle(1, {
      type: "start",
      generation,
      replyToMessageId: 10,
    });
    streamer.handle(1, { type: "delta", generation, text: "draft" });
    await waitFor(() => requestSignal !== undefined);

    await streamer.abortChat(1);

    expect(requestSignal?.aborted).toBeTrue();
  });

  test("draft 请求超时后停止预览而不永久阻塞", async () => {
    let requestSignal: AbortSignal | undefined;
    const logger = new RecordingLogger();
    const streamer = new TelegramDraftStreamer(
      {
        sendMessageDraft: async (_chatId, _draftId, _text, _other, signal) => {
          requestSignal = signal;
          return new Promise<true>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new DOMException("timeout", "AbortError")),
              { once: true },
            );
          });
        },
      },
      logger,
      { intervalMs: 1, requestTimeoutMs: 5 },
    );
    const generation = { revision: 1, segment: 1 };
    streamer.handle(1, {
      type: "start",
      generation,
      replyToMessageId: 10,
    });
    streamer.handle(1, { type: "delta", generation, text: "draft" });

    await waitFor(() => logger.events().includes("telegram_draft_failed"));
    await streamer.finish(1, generation);

    expect(requestSignal?.aborted).toBeTrue();
  });

  test("finish 会等待在途 draft 请求结束", async () => {
    let release: (() => void) | undefined;
    let requestStarted = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const streamer = new TelegramDraftStreamer(
      {
        sendMessageDraft: async () => {
          requestStarted = true;
          await gate;
          return true;
        },
      },
      undefined,
      { intervalMs: 1 },
    );
    const generation = { revision: 1, segment: 1 };
    streamer.handle(1, {
      type: "start",
      generation,
      replyToMessageId: 10,
    });
    streamer.handle(1, { type: "delta", generation, text: "wait" });

    await waitFor(() => requestStarted);
    let finished = false;
    const finishing = streamer.finish(1, generation).then(() => {
      finished = true;
    });
    await Bun.sleep(2);
    expect(finished).toBeFalse();
    release?.();
    await finishing;
    expect(finished).toBeTrue();
  });

  test("draft 失败只关闭本次预览并记录安全日志", async () => {
    let calls = 0;
    const logger = new RecordingLogger();
    const streamer = new TelegramDraftStreamer(
      {
        sendMessageDraft: async () => {
          calls += 1;
          throw new Error("private Telegram failure");
        },
      },
      logger,
      { intervalMs: 1 },
    );
    const generation = { revision: 3, segment: 1 };

    streamer.handle(1, {
      type: "start",
      generation,
      replyToMessageId: 99,
    });
    streamer.handle(1, { type: "delta", generation, text: "ignored" });
    await waitFor(() => logger.events().includes("telegram_draft_failed"));
    await streamer.finish(1, generation);

    expect(calls).toBe(1);
    expect(logger.entries).toEqual([
      {
        event: "telegram_draft_failed",
        fields: {
          chat_id: 1,
          reply_to_message_id: 99,
          revision: 3,
          segment: 1,
          error_name: "Error",
          reason: "draft_send_failed",
        },
      },
    ]);
  });
});

describe("draftPreview", () => {
  test("只保留 4096 UTF-16 units 且不切断 emoji", () => {
    const preview = draftPreview(`${"a".repeat(4094)}😀tail`);

    expect(preview.length).toBeLessThanOrEqual(4096);
    expect(preview).toStartWith("…\n");
    expect(preview).toEndWith("😀tail");
    const firstSuffixUnit = preview.charCodeAt(2);
    expect(firstSuffixUnit >= 0xdc00 && firstSuffixUnit <= 0xdfff).toBeFalse();
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return;
    }
    await Bun.sleep(2);
  }
  throw new Error("condition not reached");
}
