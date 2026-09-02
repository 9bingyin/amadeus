import { describe, expect, test } from "bun:test";
import type { PiRpcEvent } from "../../src/pi-rpc/types";
import {
  TelegramActivityPresenter,
  type TelegramActivityApi,
} from "../../src/telegram/activity";
import { RecordingLogger } from "../helpers/recording-logger";

class FakeActivityApi implements TelegramActivityApi {
  readonly typing: number[] = [];
  readonly sent: Array<{ text: string; silent: boolean }> = [];
  readonly edited: string[] = [];
  readonly deleted: number[] = [];
  failDelete = false;
  failTyping = false;

  async sendChatAction(chatId: number): Promise<void> {
    this.typing.push(chatId);
    if (this.failTyping) {
      throw new Error("typing failed with secret body");
    }
  }

  async sendMessage(
    _chatId: number,
    text: string,
    options: { disable_notification: true },
  ): Promise<{ message_id: number }> {
    this.sent.push({ text, silent: options.disable_notification });
    return { message_id: 99 };
  }

  async editMessageText(
    _chatId: number,
    _messageId: number,
    text: string,
  ): Promise<void> {
    this.edited.push(text);
  }

  async deleteMessage(_chatId: number, messageId: number): Promise<void> {
    this.deleted.push(messageId);
    if (this.failDelete) {
      throw new Error("message not found");
    }
  }
}

describe("TelegramActivityPresenter", () => {
  test("发送 typing，静默汇总工具，隐藏命令参数，并在完成后删除", async () => {
    const api = new FakeActivityApi();
    const presenter = new TelegramActivityPresenter(api);

    presenter.handleEvent(1, { type: "agent_start" });
    presenter.handleEvent(1, {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "curl https://secret.invalid?token=secret" },
    });
    presenter.handleEvent(1, {
      type: "tool_execution_start",
      toolCallId: "tool-2",
      toolName: "read",
      args: { path: "/home/user/project/src/index.ts" },
    });
    await waitFor(() => api.sent.length === 1);

    presenter.handleEvent(1, toolEnd("tool-1", "bash"));
    presenter.handleEvent(1, toolEnd("tool-2", "read"));
    presenter.handleEvent(1, { type: "agent_settled" });
    await waitFor(() => api.edited.length === 1);
    await presenter.finish(1);

    expect(api.typing.length).toBeGreaterThan(0);
    expect(api.sent[0]?.text).not.toContain("Tool activity");
    expect(api.sent[0]?.text).not.toContain("secret");
    expect(api.sent[0]?.text).toContain(".../project/src/index.ts");
    expect(api.sent[0]?.silent).toBeTrue();
    expect(api.edited[0]).toContain("[done]");
    expect(api.deleted).toEqual([99]);
  });

  test("压缩期间持续 typing 并显示临时状态", async () => {
    const api = new FakeActivityApi();
    const presenter = new TelegramActivityPresenter(api);

    presenter.startCompaction(1);
    await waitFor(() => api.sent.length === 1);
    await presenter.finish(1);

    expect(api.typing.length).toBeGreaterThan(0);
    expect(api.sent).toEqual([{ text: "压缩中...", silent: true }]);
    expect(api.deleted).toEqual([99]);
  });

  test("typing 失败只记录安全状态", async () => {
    const api = new FakeActivityApi();
    api.failTyping = true;
    const logger = new RecordingLogger();
    const presenter = new TelegramActivityPresenter(api, logger);

    presenter.handleEvent(1, { type: "agent_start" });
    await waitFor(() => logger.entries.length === 1);
    await presenter.finish(1);

    expect(logger.entries).toEqual([
      {
        event: "telegram_activity_failed",
        fields: {
          chat_id: 1,
          action: "typing",
          error_name: "Error",
          reason: "typing_failed",
        },
      },
    ]);
  });

  test("删除临时消息失败不会阻塞清理", async () => {
    const api = new FakeActivityApi();
    api.failDelete = true;
    const presenter = new TelegramActivityPresenter(api);
    presenter.handleEvent(1, {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "/tmp/file" },
    });
    await waitFor(() => api.sent.length === 1);

    await expect(presenter.finish(1)).resolves.toBeUndefined();
    expect(api.deleted).toEqual([99]);
  });
});

function toolEnd(id: string, name: string): PiRpcEvent {
  return {
    type: "tool_execution_end",
    toolCallId: id,
    toolName: name,
    result: {},
    isError: false,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("等待测试条件超时");
}
