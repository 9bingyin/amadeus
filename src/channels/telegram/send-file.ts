import { withoutAbortSignal } from "@earendil-works/chord/context";
import { defineTool, type ConversationId } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { InputFile, type Api, type Bot } from "grammy";
import { z } from "zod";
import { TelegramState } from "./conversations";

// grammY 使用旧版 AbortSignal 声明；原生信号在运行时兼容。
type TelegramSignal = NonNullable<Parameters<Api["sendDocument"]>[3]>;

export function createSendFileTool(
  bot: Bot,
  allowed: ReadonlySet<number>,
  beforeSend: (conversation: ConversationId) => Promise<void>,
  afterSend: (conversation: ConversationId) => void,
) {
  return defineTool({
    name: "send_file",
    description:
      "Send a local file to the current Telegram chat and topic. Paths are relative to your cwd or absolute. kind defaults to document: send the original file unchanged, up to 50 MiB. Use photo for a Telegram-compressed image, up to 10 MiB. caption is optional plain text, at most 1024 characters. Do not export secrets. An interrupted call may already have delivered the file; do not blindly resend.",
    parameters: obj({
      path: str({ minLength: 1 }),
      kind: opt(oneOf(["document", "photo"])),
      caption: opt(str({ maxLength: 1024 })),
    }),
    structuredOutputSchema: obj({
      messageId: int(),
      name: str(),
      kind: oneOf(["document", "photo"]),
      size: int(),
    }),
    replay: "unsafe",
    async execute(args, api, context) {
      const state = await api.snapshot(TelegramState, context);
      z.literal(bot.botInfo.id).parse(state?.botId);
      const route = z
        .string()
        .parse(
          Object.entries(state?.chats ?? {}).find(
            ([, id]) => id === api.conversationId,
          )?.[0],
        );
      const [chat, thread] = route.split(":");
      const chatId = Number(chat);
      z.literal(true).parse(allowed.has(chatId));
      // openAgent 始终为本应用的工具提供 NodeExecutionEnv。
      const env = api.env!;
      const reader = getOrThrow(
        await env.openBinaryReader(args.path, undefined, context),
      );
      try {
        const info = getOrThrow(await reader.info(context));
        const kind = args.kind ?? "document";
        z.number()
          .nonnegative()
          .max((kind === "photo" ? 10 : 50) * 1024 * 1024)
          .parse(info.size);
        const file = new InputFile(async function* () {
          let offset = 0;
          while (offset < info.size) {
            const bytes = getOrThrow(
              await reader.read(
                offset,
                Math.min(1024 * 1024, info.size - offset),
                context,
              ),
            );
            z.number().positive().parse(bytes.length);
            offset += bytes.length;
            yield bytes;
          }
        }, info.name);
        await beforeSend(api.conversationId);
        context.abortSignal?.throwIfAborted();
        const options = {
          caption: args.caption ?? "",
          ...(Number(thread) ? { message_thread_id: Number(thread) } : {}),
        };
        const signal = context.abortSignal as TelegramSignal | undefined;
        const message =
          kind === "photo"
            ? await bot.api.sendPhoto(chatId, file, options, signal)
            : await bot.api.sendDocument(chatId, file, options, signal);
        afterSend(api.conversationId);
        const result = {
          messageId: message.message_id,
          name: info.name,
          kind,
          size: info.size,
        };
        return {
          output: [{ type: "text", text: JSON.stringify(result) }],
          structuredOutput: result,
        };
      } finally {
        await reader.close(withoutAbortSignal(context));
      }
    },
  });
}
