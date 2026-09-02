import { describe, expect, test } from "bun:test";
import type { AutoRetryOptions } from "@grammyjs/auto-retry";
import { Bot, GrammyError, HttpError, type Transformer } from "grammy";
import { createTelegramRetryTransformer } from "../../src/telegram/retry";

describe("createTelegramRetryTransformer", () => {
  test("只对幂等或可安全重复的 API 启用网络和 5xx 重试", async () => {
    const options: Array<Partial<AutoRetryOptions>> = [];
    const createRetry = (value: Partial<AutoRetryOptions>): Transformer => {
      options.push(value);
      const mode = value.rethrowInternalServerErrors
        ? "rate-limit-only"
        : "transient";
      return async () => {
        throw new Error(mode);
      };
    };
    const retry = createTelegramRetryTransformer(createRetry);
    const unreachable = async (): Promise<never> => {
      throw new Error("unreachable");
    };

    await expect(
      retry(unreachable, "getFile", { file_id: "file" }),
    ).rejects.toThrow("transient");
    await expect(
      retry(unreachable, "sendMessageDraft", {
        chat_id: 1,
        draft_id: 1,
        text: "draft",
      }),
    ).rejects.toThrow("transient");
    await expect(
      retry(unreachable, "sendMessage", { chat_id: 1, text: "message" }),
    ).rejects.toThrow("rate-limit-only");
    await expect(
      retry(unreachable, "sendPhoto", { chat_id: 1, photo: "file" }),
    ).rejects.toThrow("rate-limit-only");

    expect(options).toEqual([
      {
        maxRetryAttempts: 3,
        maxDelaySeconds: 30,
        rethrowHttpErrors: true,
        rethrowInternalServerErrors: false,
      },
      {
        maxRetryAttempts: 3,
        maxDelaySeconds: 30,
        rethrowHttpErrors: true,
        rethrowInternalServerErrors: true,
      },
    ]);
  });

  test("允许网络重试的方法在固定次数后停止", async () => {
    const delays: number[] = [];
    const retry = createTelegramRetryTransformer(
      () => async (prev, method, payload, signal) =>
        prev(method, payload, signal),
      async (delayMs) => {
        delays.push(delayMs);
      },
    );
    let attempts = 0;
    const failWithNetworkError = async (): Promise<never> => {
      attempts += 1;
      throw new HttpError("network failed", new Error("connection reset"));
    };

    await expect(
      retry(failWithNetworkError, "getFile", { file_id: "file" }),
    ).rejects.toMatchObject({ name: "TelegramRetryExhaustedError" });
    expect(attempts).toBe(4);
    expect(delays).toEqual([1_000, 2_000, 4_000]);
  });

  test("Bot.start 的外层重试不会突破网络重试上限", async () => {
    let attempts = 0;
    const fetchApi = Object.assign(
      async (): Promise<Response> => {
        attempts += 1;
        throw new Error("offline");
      },
      { preconnect: fetch.preconnect },
    ) satisfies typeof fetch;
    const bot = new Bot("123:token", {
      botInfo: {
        id: 999,
        is_bot: true,
        first_name: "Amadeus",
        username: "amadeus_test_bot",
        can_join_groups: false,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
        can_connect_to_business: false,
        has_main_web_app: false,
        has_topics_enabled: false,
        allows_users_to_create_topics: false,
        can_manage_bots: false,
        supports_join_request_queries: false,
      },
      client: { fetch: fetchApi },
    });
    bot.api.config.use(
      createTelegramRetryTransformer(undefined, async () => undefined),
    );

    await expect(bot.start()).rejects.toMatchObject({
      name: "TelegramRetryExhaustedError",
    });
    expect(attempts).toBe(4);
  });

  test("非幂等发送遇到 5xx 时不会自动重试", async () => {
    const retry = createTelegramRetryTransformer();
    let attempts = 0;
    const failWithServerError = async (): Promise<never> => {
      attempts += 1;
      throw new GrammyError(
        "server failed",
        {
          ok: false,
          error_code: 500,
          description: "Internal Server Error",
        },
        "sendMessage",
        { chat_id: 1, text: "message" },
      );
    };

    await expect(
      retry(failWithServerError, "sendMessage", {
        chat_id: 1,
        text: "message",
      }),
    ).rejects.toBeInstanceOf(GrammyError);
    expect(attempts).toBe(1);
  });

  test("非幂等发送遇到网络错误时不会自动重试", async () => {
    const retry = createTelegramRetryTransformer();
    let attempts = 0;
    const failWithNetworkError = async (): Promise<never> => {
      attempts += 1;
      throw new HttpError("network failed", new Error("connection reset"));
    };

    await expect(
      retry(failWithNetworkError, "sendMessage", {
        chat_id: 1,
        text: "message",
      }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(attempts).toBe(1);
  });
});
