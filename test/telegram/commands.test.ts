import { describe, expect, test } from "bun:test";
import {
  registerTelegramCommands,
  type TelegramCommandApi,
} from "../../src/telegram/commands";

describe("registerTelegramCommands", () => {
  test("为所有私聊注册会话控制命令", async () => {
    const calls: Array<{
      commands: Parameters<TelegramCommandApi["setMyCommands"]>[0];
      options: Parameters<TelegramCommandApi["setMyCommands"]>[1];
    }> = [];
    const api: TelegramCommandApi = {
      async getMyCommands() {
        return [{ command: "help", description: "外部帮助" }];
      },
      async setMyCommands(commands, options) {
        calls.push({ commands, options });
        return true;
      },
    };

    await registerTelegramCommands(api);

    expect(calls).toEqual([
      {
        commands: [
          { command: "new", description: "开始新会话" },
          { command: "status", description: "查看会话状态" },
          { command: "stop", description: "停止当前处理" },
          { command: "compact", description: "压缩会话上下文" },
          { command: "restart", description: "重启当前会话" },
          { command: "help", description: "外部帮助" },
        ],
        options: { scope: { type: "all_private_chats" } },
      },
    ]);
  });
});
