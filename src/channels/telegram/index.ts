import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ConversationBusy,
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
import { splitMessage } from "telegram-md-entities";
import type { Agent } from "../../agent";
import type { TelegramConfig } from "../../config";
import { NotificationTask } from "../notifications";
import type { Channel } from "..";
import {
  TelegramConversations,
  TelegramState,
  type MessageContext,
} from "./conversations";
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
  function destination(
    state:
      | {
          botId: number | null;
          chats: Readonly<Record<string, ConversationId>>;
        }
      | undefined,
    conversation: ConversationId,
  ) {
    if (state?.botId !== bot.botInfo.id) return undefined;
    const route = Object.entries(state.chats).find(
      ([, id]) => id === conversation,
    )?.[0];
    if (route === undefined) return undefined;
    const [chat, thread] = route.split(":");
    const chatId = Number(chat);
    return allowed.has(chatId)
      ? { chatId, threadId: Number(thread) || null }
      : undefined;
  }
  let refreshTyping: ((conversation: ConversationId) => void) | undefined;
  const progress = await openToolProgress(bot, agent.harness, allowed, (id) =>
    refreshTyping?.(id),
  );
  resources.defer(() => progress.close());
  let stream: ReplyStream | undefined;
  const delivery = createDeliveryTask(
    agent.harness,
    async (conversation, destination, message, signal) => {
      const state = await agent.harness.snapshot(
        TelegramState,
        BACKGROUND_CONTEXT,
      );
      if (state?.botId !== bot.botInfo.id || !allowed.has(destination.chatId))
        return;
      await stream?.stop(conversation);
      const sent = await bot.api.sendMessage(
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
      console.info(
        `Telegram reply sent: conversation=${conversation} chat=${destination.chatId} message=${sent.message_id}`,
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
      wraps: [TelegramPrompt],
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
        hook(NotificationTask, {
          admitted: async (tx, conversation, submission) => {
            const target = destination(
              await tx.doc(TelegramState),
              conversation,
            );
            if (!target) return;
            await tx.createTask(
              delivery,
              {
                ...target,
                through: null,
                kind: "failure",
                id: submission,
              },
              {
                ownership: { kind: "conversation" },
                conversationId: conversation,
                background: true,
              },
            );
          },
        }),
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
            const target = destination(
              await api.snapshot(TelegramState, context),
              api.conversationId,
            );
            if (target)
              return {
                tasks: [
                  runEndTask(delivery, {
                    ...target,
                    through: null,
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
    if (ctx.match.trim()) await ctx.reply("This command takes no arguments.");
    else await next();
  };
  messages.command("new", noArguments, conversations.command, async (ctx) => {
    const conversation = await conversations.conversation(ctx);
    await conversation.abort(BACKGROUND_CONTEXT, { background: true });
    progress.clear(conversation.id);
    await stream?.stop(conversation.id);
    await conversation.reset(undefined, BACKGROUND_CONTEXT);
    console.info(`Conversation reset: conversation=${conversation.id}`);
    await ctx.reply("Context reset.");
  });
  messages.command("stop", noArguments, conversations.command, async (ctx) => {
    const conversation = await conversations.conversation(ctx);
    const busy = await conversation.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, conversation.id);
      const ingress = await tx.doc(Ingress, conversation.id);
      return (
        live.run !== undefined ||
        !!live.compactions?.length ||
        ingress.tail !== null
      );
    }, BACKGROUND_CONTEXT);
    await conversation.abort(BACKGROUND_CONTEXT, { background: true });
    progress.clear(conversation.id);
    await stream?.stop(conversation.id);
    console.info(
      `Stop handled: conversation=${conversation.id} active=${busy}`,
    );
    await ctx.reply(busy ? "Stopped." : "Nothing to stop.");
  });
  messages.command(
    "continue",
    noArguments,
    conversations.command,
    async (ctx) => {
      const conversation = await conversations.conversation(ctx);
      const target = {
        chatId: ctx.chat.id,
        threadId: ctx.msg.message_thread_id ?? null,
      };
      const request = `telegram:continue:${ctx.me.id}:${ctx.update.update_id}`;
      try {
        const submission = await conversation.commit(async (tx) => {
          if (await tx.submissionByRequest(conversation.id, request))
            return undefined;
          const ingress = await tx.doc(Ingress, conversation.id);
          if (ingress.tail !== null)
            throw new ConversationBusy(conversation.id);
          const id = await conversation.submit(tx, {
            type: "continue",
            requestId: request,
          });
          await tx.createTask(
            delivery,
            { ...target, through: null, kind: "failure", id },
            {
              ownership: { kind: "conversation" },
              conversationId: conversation.id,
              background: true,
            },
          );
          return id;
        }, BACKGROUND_CONTEXT);
        if (submission !== undefined)
          console.info(
            `Continue requested: conversation=${conversation.id} submission=${submission}`,
          );
      } catch (error) {
        if (error instanceof ConversationBusy) {
          await ctx.reply("Already working.");
          return;
        }
        throw error;
      }
    },
  );
  messages.command(
    "compact",
    noArguments,
    conversations.command,
    async (ctx) => {
      const conversation = await conversations.conversation(ctx);
      const task = await conversation.compact(undefined, BACKGROUND_CONTEXT);
      console.info(
        `Compaction requested: conversation=${conversation.id} task=${task}`,
      );
      await ctx.reply("Compaction requested.");
    },
  );
  messages.command("schedule", noArguments, async (ctx) => {
    const text = await conversations.schedules(ctx);
    for (const chunk of splitMessage({ text, entities: [] }))
      await ctx.reply(chunk.text);
  });
  messages.command("reload", noArguments, async (ctx) => {
    await agent.reload();
    await ctx.reply("Reloaded.");
  });
  messages.command("status", noArguments, async (ctx) => {
    const text = await conversations.status(ctx);
    for (const chunk of splitMessage({ text, entities: [] }))
      await ctx.reply(chunk.text);
  });
  messages.command(["start", "help"], (ctx) =>
    ctx.reply(
      "Send a message or attachment.\n\n/new — Reset context\n/stop — Stop processing\n/continue — Continue interrupted run\n/compact — Compact context\n/schedule — List schedules\n/reload — Reload prompt and skills\n/status — Show status",
    ),
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
        { command: "new", description: "Reset context" },
        { command: "stop", description: "Stop processing" },
        { command: "continue", description: "Continue interrupted run" },
        { command: "compact", description: "Compact context" },
        { command: "schedule", description: "List schedules" },
        { command: "reload", description: "Reload prompt and skills" },
        { command: "status", description: "Show status" },
      ],
      { scope: { type: "all_private_chats" } },
      // 同样仅适配 grammY 的类型声明，运行时仍传入原生 signal。
      signal as TelegramSignal,
    );
    if (signal.aborted) return;
    polling = bot.start({
      allowed_updates: ["message"],
      onStart: (info) =>
        console.info(`Telegram polling started: @${info.username}`),
    });
    await polling;
    console.info("Telegram polling stopped");
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
