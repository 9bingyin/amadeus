import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  defineExtension,
  GenerationTask,
  hook,
  LiveDoc,
  runEndTask,
  type Cursor,
} from "@earendil-works/pi-durable";
import { autoRetry } from "@grammyjs/auto-retry";
import {
  Bot,
  HttpError,
  type Api,
  type CommandContext,
  type MiddlewareFn,
} from "grammy";
import type { Agent } from "../../agent";
import type { TelegramConfig } from "../../config";
import type { Channel } from "..";
import { TelegramConversations, type MessageContext } from "./conversations";
import { createDeliveryTask } from "./delivery";
import { createBatchTask, Ingress, TelegramInput } from "./inbound";
import { createPhotoLoader } from "./photos";
import { watchTyping } from "./typing";

// grammY 的 Node 类型使用旧版 AbortSignal，运行时兼容原生 signal。
type TelegramSignal = NonNullable<Parameters<Api["sendMessage"]>[3]>;

export async function configureTelegram(
  bot: Bot,
  agent: Agent,
  config: TelegramConfig,
): Promise<void> {
  bot.api.config.use(autoRetry());
  await bot.init();
  const allowed = new Set(config.allowedUserIds);
  const delivery = createDeliveryTask(
    agent.harness,
    async (destination, text, signal) => {
      if (!allowed.has(destination.chatId)) return;
      await bot.api.sendMessage(
        destination.chatId,
        text,
        {
          ...(destination.threadId === null
            ? {}
            : { message_thread_id: destination.threadId }),
        },
        // 仅适配 grammY 的旧版 AbortSignal 声明；原生 signal 的取消行为已验证。
        signal as TelegramSignal,
      );
    },
  );
  const batch = createBatchTask(
    agent.harness,
    delivery,
    createPhotoLoader(bot),
  );
  const conversations = new TelegramConversations(
    agent,
    batch,
    config.inputWindowMs,
  );
  await conversations.initialize(bot.botInfo.id);
  agent.registry.install(
    defineExtension({
      name: "amadeus.telegram",
      tasks: [delivery, batch],
      hooks: [
        hook(GenerationTask, {
          afterRun: async (run, api, context) => {
            let cursor: Cursor | undefined;
            do {
              const page = await api.entries(
                { minEntryId: run.first, maxEntryId: run.last },
                64,
                cursor,
                context,
              );
              const input = page.items.find(TelegramInput.is);
              if (input)
                return {
                  tasks: [
                    runEndTask(delivery, {
                      ...input.data,
                      kind: "answer",
                      id: run.answer,
                    }),
                  ],
                };
              cursor = page.next;
            } while (cursor !== undefined);
            return undefined;
          },
        }),
      ],
    }),
  );

  await watchTyping(bot, agent.harness, allowed);

  const messages = bot
    .on("message")
    .filter(
      (ctx) =>
        ctx.chat.type === "private" &&
        !ctx.from.is_bot &&
        allowed.has(ctx.from.id),
    );
  const noArguments: MiddlewareFn<CommandContext<MessageContext>> = async (
    ctx,
    next,
  ) => {
    if (ctx.match.trim()) await ctx.reply("该命令不接受参数。");
    else await next();
  };
  messages.command("new", noArguments, conversations.command, async (ctx) => {
    const conversation = await conversations.conversation(ctx);
    await conversation.abort(BACKGROUND_CONTEXT, { background: true });
    await conversation.reset(undefined, BACKGROUND_CONTEXT);
    await ctx.reply("已开启新会话。");
  });
  messages.command("stop", noArguments, conversations.command, async (ctx) => {
    const conversation = await conversations.conversation(ctx);
    const busy = await conversation.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, conversation.id);
      const ingress = await tx.doc(Ingress, conversation.id);
      return live.run !== undefined || ingress.tail !== null;
    }, BACKGROUND_CONTEXT);
    await conversation.abort(BACKGROUND_CONTEXT, { background: true });
    await ctx.reply(busy ? "已停止当前任务。" : "当前没有运行中的任务。");
  });
  messages.command("status", noArguments, async (ctx) => {
    await ctx.reply(await conversations.status(ctx));
  });
  messages.command(["start", "help"], (ctx) =>
    ctx.reply("可直接发送文本，或使用 /new、/stop、/status。"),
  );
  messages
    .filter(
      (ctx) =>
        ctx.msg.entities?.some(
          (entity) => entity.type === "bot_command" && entity.offset === 0,
        ) ?? false,
    )
    .use(() => {});
  messages.on(["message:text", "message:photo"], (ctx) =>
    conversations.receive(ctx),
  );
  messages.use((ctx) => ctx.reply("目前仅支持文本和图片。"));
  bot.catch(({ error }) => {
    throw error;
  });
}

export async function openTelegram(
  agent: Agent,
  config: TelegramConfig,
): Promise<Channel> {
  const bot = new Bot(config.token);
  await configureTelegram(bot, agent, config);
  return { run: (signal) => runTelegram(bot, signal) };
}

export async function runTelegram(
  bot: Bot,
  signal: AbortSignal,
): Promise<void> {
  let stopping: Promise<void> | undefined;
  function stop(): void {
    if (bot.isRunning()) {
      stopping ??= bot.stop();
      void stopping.catch(console.error);
    }
  }
  signal.addEventListener("abort", stop, { once: true });
  let polling: Promise<void> | undefined;
  try {
    if (signal.aborted) return;
    await bot.api.setMyCommands(
      [
        { command: "new", description: "开启新会话" },
        { command: "stop", description: "停止当前任务" },
        { command: "status", description: "查看会话状态" },
      ],
      { scope: { type: "all_private_chats" } },
      // 同样仅适配 grammY 的类型声明，运行时仍传入原生 signal。
      signal as TelegramSignal,
    );
    if (signal.aborted) return;
    polling = bot.start({
      allowed_updates: ["message"],
      onStart: (info) => console.log(`Amadeus 已启动：@${info.username}`),
    });
    await polling;
  } catch (error) {
    const cause = error instanceof HttpError ? error.error : error;
    if (
      !signal.aborted ||
      !(cause instanceof Error) ||
      cause.name !== "AbortError"
    )
      throw error;
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
    try {
      await stopping;
    } finally {
      await polling;
    }
  }
}
