import type { BotCommand } from "@grammyjs/types";

export const TELEGRAM_COMMANDS = [
  {
    command: "new",
    description: "开始新会话",
  },
  {
    command: "status",
    description: "查看会话状态",
  },
  {
    command: "stop",
    description: "停止当前处理",
  },
  {
    command: "compact",
    description: "压缩会话上下文",
  },
  {
    command: "restart",
    description: "重启当前会话",
  },
] as const satisfies readonly BotCommand[];

const PRIVATE_CHAT_SCOPE = {
  scope: { type: "all_private_chats" },
} as const;

export interface TelegramCommandApi {
  getMyCommands(options: typeof PRIVATE_CHAT_SCOPE): Promise<BotCommand[]>;
  setMyCommands(
    commands: BotCommand[],
    options: typeof PRIVATE_CHAT_SCOPE,
  ): Promise<unknown>;
}

export async function registerTelegramCommands(
  api: TelegramCommandApi,
): Promise<void> {
  const existing = await api.getMyCommands(PRIVATE_CHAT_SCOPE);
  const managedNames = new Set<string>(
    TELEGRAM_COMMANDS.map((command) => command.command),
  );
  const commands = [
    ...TELEGRAM_COMMANDS,
    ...existing.filter((command) => !managedNames.has(command.command)),
  ];
  await api.setMyCommands(commands, PRIVATE_CHAT_SCOPE);
}
