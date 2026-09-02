import { describe, expect, test } from "bun:test";
import {
  ignoreTelegramStatusFailure,
  publicPiError,
  rethrowTelegramUpdateFailure,
} from "../src/app";
import { UnresolvableTelegramReplyError } from "../src/bridge/prompt-compiler";
import { RecordingLogger } from "./helpers/recording-logger";

const BACKEND_NAME = "Pi";

describe("publicPiError", () => {
  test("用户错误文案不暴露具体后端", () => {
    const messages = [
      publicPiError(new UnresolvableTelegramReplyError(999)),
      publicPiError(new Error("Pi 扩展取消了新建 session")),
      publicPiError(new Error("Pi session 不匹配")),
      publicPiError(new Error("unexpected")),
    ];

    expect(messages).toEqual([
      "无法读取被回复的 Telegram 消息，本条消息未提交给助手。请重新发送或转发原消息内容。",
      "无法开始新会话：操作已取消。",
      "无法恢复会话。请检查服务端会话文件。",
      "消息处理失败。请检查服务日志后重试。",
    ]);
    for (const message of messages) {
      expect(message).not.toContain(BACKEND_NAME);
    }
  });
});

describe("ignoreTelegramStatusFailure", () => {
  test("预期的状态消息 API 失败不会终止 update", async () => {
    await expect(
      ignoreTelegramStatusFailure(Promise.reject(new Error("network failed"))),
    ).resolves.toBeUndefined();
  });
});

describe("rethrowTelegramUpdateFailure", () => {
  test("记录安全日志后重新抛出，使长轮询不确认失败 update", () => {
    const logger = new RecordingLogger();
    const failure = {
      ctx: { update: { update_id: 42 } },
      error: new Error("private middleware failure"),
    };

    let thrown: unknown;
    try {
      rethrowTelegramUpdateFailure(logger, failure);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(failure);
    expect(logger.entries).toEqual([
      {
        event: "telegram_update_failed",
        fields: {
          update_id: 42,
          error_name: "Error",
          reason: "update_handler_failed",
        },
      },
    ]);
  });
});
