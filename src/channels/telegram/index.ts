import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  defineExtension,
  GenerationTask,
  hook,
  LiveDoc,
  runEndTask,
  ToolTask,
  type ConversationId,
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
import { join } from "node:path";
import type { Agent } from "../../agent";
import type { TelegramConfig } from "../../config";
import type { Channel } from "..";
import { TelegramConversations, type MessageContext } from "./conversations";
import { createAttachmentLoader } from "./attachments";
import { createDeliveryTask } from "./delivery";
import { createBatchTask, Ingress, TelegramInput } from "./inbound";
import { openToolProgress } from "./progress";
import { TelegramPrompt } from "./prompt";
import { createSendFileTool } from "./send-file";
import { openReplyStream, type ReplyStream } from "./streaming";
import { watchTyping } from "./typing";

// grammY 的 Node 类型使用旧版 AbortSignal，运行时兼容原生 signal。
type TelegramSignal = NonNullable<Parameters<Api["sendMessage"]>[3]>;

export type TelegramOutput = {
  flush(): Promise<void>;
  close(): Promise<void>;
};

export async function configureTelegram(
  bot: Bot,
  agent: Agent,
  config: TelegramConfig,
): Promise<TelegramOutput> {
  await using resources = new AsyncDisposableStack();
  const retry = autoRetry();
  const uploadRetry = autoRetry({
    rethrowHttpErrors: true,
    rethrowInternalServerErrors: true,
  });
  bot.api.config.use((prev, method, payload, signal) =>
    (method === "sendDocument" || method === "sendPhoto" ? uploadRetry : retry)(
      prev,
      method,
      payload,
      signal,
    ),
  );
  await bot.init();
  const allowed = new Set(config.allowedUserIds);
  let refreshTyping: ((conversation: ConversationId) => void) | undefined;
  const progress = await openToolProgress(bot, agent.harness, allowed, (id) =>
    refreshTyping?.(id),
  );
  resources.defer(() => progress.close());
  let stream: ReplyStream | undefined;
  const delivery = createDeliveryTask(
    agent.harness,
    async (conversation, destination, message, signal) => {
      if (!allowed.has(destination.chatId)) return;
      await stream?.stop(conversation);
      await bot.api.sendMessage(
        destination.chatId,
        message.text,
        {
          entities: message.entities,
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
    createAttachmentLoader(
      bot,
      join(agent.stateDirectory, "uploads"),
      agent.images,
    ),
  );
  const conversations = new TelegramConversations(
    agent,
    batch,
    config.inputWindowMs,
  );
  await conversations.initialize(bot.botInfo.id);
  if (config.streaming) {
    stream = await openReplyStream(bot, agent.harness, allowed);
    resources.defer(() => stream?.close());
  }
  agent.registry.install(
    defineExtension({
      name: "amadeus.telegram",
      sections: [TelegramPrompt],
      tools: [
        createSendFileTool(
          bot,
          allowed,
          async (conversation) => {
            await stream?.stop(conversation);
          },
          (conversation) => refreshTyping?.(conversation),
        ),
      ],
      tasks: [delivery, batch],
      hooks: [
        hook(ToolTask, { beforeTool: progress.beforeTool }),
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

  refreshTyping = await watchTyping(bot, agent.harness, allowed);

  const messages = bot
    .on("message")
    .filter(
      (ctx) =>
        ctx.chat.type === "private" &&
        !ctx.from.is_bot &&
        allowed.has(ctx.from.id),
    );
  messages.use(async (ctx, next) => {
    await conversations.receive(ctx);
    await next();
  });
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
    progress.clear(conversation.id);
    await stream?.stop(conversation.id);
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
    progress.clear(conversation.id);
    await stream?.stop(conversation.id);
    await ctx.reply(busy ? "已停止当前任务。" : "当前没有运行中的任务。");
  });
  messages.command("status", noArguments, async (ctx) => {
    await ctx.reply(await conversations.status(ctx));
  });
  messages.command(["start", "help"], (ctx) =>
    ctx.reply("可直接发送消息或附件，或使用 /new、/stop、/status。"),
  );
  bot.catch(({ error }) => {
    throw error;
  });
  const cleanup = resources.move();
  let closing: Promise<void> | undefined;
  return {
    async flush() {
      await Promise.all([stream?.flush(), progress.flush()]);
    },
    close() {
      closing ??= cleanup.disposeAsync();
      return closing;
    },
  };
}

export async function openTelegram(
  agent: Agent,
  config: TelegramConfig,
): Promise<Channel> {
  const bot = new Bot(config.token);
  const output = await configureTelegram(bot, agent, config);
  return {
    run: async (signal) => {
      try {
        await runTelegram(bot, signal);
      } finally {
        await output.close();
      }
    },
  };
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
