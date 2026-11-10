import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  defineExtension,
  GenerationTask,
  hook,
  LiveDoc,
  runEndTask,
  type Harness,
} from "@earendil-works/pi-durable";
import { autoRetry } from "@grammyjs/auto-retry";
import type { Api, Bot, CommandContext, MiddlewareFn } from "grammy";
import type { Agent } from "../agent";
import { TelegramConversations, type MessageContext } from "./conversations";
import { createDeliveryTask, TelegramInput } from "./delivery";

// grammY 的 Node 类型使用旧版 AbortSignal，运行时兼容原生 signal。
type TelegramSignal = NonNullable<Parameters<Api["sendMessage"]>[3]>;

export async function configureTelegram(
  bot: Bot,
  agent: Agent,
  allowedUserIds: readonly number[],
): Promise<void> {
  bot.api.config.use(autoRetry());
  await bot.init();
  const allowed = new Set(allowedUserIds);
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
  const conversations = new TelegramConversations(agent, delivery);
  await conversations.initialize(bot.botInfo.id);
  agent.registry.install(
    defineExtension({
      name: "amadeus.telegram",
      tasks: [delivery],
      hooks: [
        hook(GenerationTask, {
          afterRun: async (run, api, context) => {
            const input = await api.entry(TelegramInput, run.first, context);
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
            return undefined;
          },
        }),
      ],
    }),
  );

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
  messages.command("new", conversations.command, noArguments, async (ctx) => {
    const conversation = await conversations.conversation(ctx);
    await conversation.abort(BACKGROUND_CONTEXT, { background: true });
    await conversation.reset(undefined, BACKGROUND_CONTEXT);
    await ctx.reply("已开启新会话。");
  });
  messages.command("stop", conversations.command, noArguments, async (ctx) => {
    const conversation = await conversations.conversation(ctx);
    const live = await agent.harness.snapshot(
      LiveDoc,
      conversation.id,
      BACKGROUND_CONTEXT,
    );
    const busy = live?.run !== undefined;
    await conversation.abort(BACKGROUND_CONTEXT, { background: true });
    await ctx.reply(busy ? "已停止当前任务。" : "当前没有运行中的任务。");
  });
  messages.command(
    "status",
    conversations.command,
    noArguments,
    async (ctx) => {
      await ctx.reply(await conversations.status(ctx));
    },
  );
  messages.command(["start", "help"], conversations.command, (ctx) =>
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
  messages.on("message:text", async (ctx) => {
    const text = ctx.msg.text.trim();
    if (text) await conversations.submit(ctx, text);
  });
  messages.use((ctx) => ctx.reply("目前仅支持文本消息。"));
  bot.catch(({ error }) => {
    throw error;
  });
}

export async function runTelegram(bot: Bot, harness: Harness): Promise<void> {
  const controller = new AbortController();
  function stop(): void {
    controller.abort();
    if (bot.isRunning()) void bot.stop().catch(console.error);
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let polling: Promise<void> | undefined;
  try {
    await bot.api.setMyCommands(
      [
        { command: "new", description: "开启新会话" },
        { command: "stop", description: "停止当前任务" },
        { command: "status", description: "查看会话状态" },
      ],
      { scope: { type: "all_private_chats" } },
      // 同样仅适配 grammY 的类型声明，运行时仍传入原生 signal。
      controller.signal as TelegramSignal,
    );
    if (controller.signal.aborted) return;
    harness.resume();
    polling = bot.start({
      allowed_updates: ["message"],
      onStart: (info) => console.log(`Amadeus 已启动：@${info.username}`),
    });
    await Promise.race([
      polling,
      harness.closed.then((end) => {
        if (end.kind === "failed") throw end.error;
      }),
    ]);
  } catch (error) {
    if (
      !controller.signal.aborted ||
      !(error instanceof Error) ||
      error.name !== "AbortError"
    )
      throw error;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (bot.isRunning()) await bot.stop();
    await polling;
  }
}
