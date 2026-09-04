import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeAgentsAndMemory,
  ignoreTelegramStatusFailure,
  publicPiError,
  rethrowTelegramUpdateFailure,
} from "../src/app";
import { UnresolvableTelegramReplyError } from "../src/bridge/prompt-compiler";
import { StateStore } from "../src/state";
import { RecordingLogger } from "./helpers/recording-logger";

const BACKEND_NAME = "Pi";

describe("closeAgentsAndMemory", () => {
  test("先排空 agent，再用最新状态关闭 memory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-app-close-"));
    try {
      const stateStore = await StateStore.open(join(directory, "state.json"));
      const order: string[] = [];
      await closeAgentsAndMemory(
        {
          close: async () => {
            order.push("agents");
            await stateStore.update((state) => {
              state.lastUpdateId = 9;
            });
          },
        },
        {
          beginShutdown: async () => {
            order.push("memory-begin");
          },
          close: async (state) => {
            order.push(`memory:${state.lastUpdateId}`);
          },
        },
        stateStore,
      );
      expect(order).toEqual(["memory-begin", "agents", "memory:9"]);
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  test("agent 关闭失败时仍关闭 memory 并汇总错误", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-app-close-"));
    try {
      const stateStore = await StateStore.open(join(directory, "state.json"));
      let memoryClosed = false;
      await expect(
        closeAgentsAndMemory(
          { close: async () => Promise.reject(new Error("agent failed")) },
          {
            beginShutdown: async () => undefined,
            close: async () => {
              memoryClosed = true;
              throw new Error("memory failed");
            },
          },
          stateStore,
        ),
      ).rejects.toBeInstanceOf(AggregateError);
      expect(memoryClosed).toBeTrue();
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});

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
