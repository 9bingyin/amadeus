import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  ConversationId,
  Harness,
  TaskGraph,
} from "@earendil-works/pi-durable";
import type { Api, Bot } from "grammy";
import { TelegramState } from "./conversations";
import type { Destination } from "./inbound";

// grammY 的 Node 类型使用旧版 AbortSignal，运行时兼容原生 signal。
type TelegramSignal = NonNullable<Parameters<Api["sendChatAction"]>[3]>;

function startTyping(bot: Bot, destination: Destination) {
  const controller = new AbortController();
  let sending = false;
  async function send(): Promise<void> {
    if (sending || controller.signal.aborted) return;
    sending = true;
    try {
      await bot.api.sendChatAction(
        destination.chatId,
        "typing",
        destination.threadId === null
          ? {}
          : { message_thread_id: destination.threadId },
        // 仅适配 grammY 的旧版声明，保留原生 signal 的取消行为。
        controller.signal as TelegramSignal,
      );
    } catch (error) {
      if (!controller.signal.aborted) console.error(error);
    } finally {
      sending = false;
    }
  }
  void send();
  // Telegram 的 chat action 约 5 秒后失效，提前续期；不影响 Agent 的运行时限。
  const timer = setInterval(() => void send(), 4_000);
  timer.unref();
  return {
    refresh: () => {
      void send();
    },
    stop() {
      clearInterval(timer);
      controller.abort();
    },
  };
}

export async function watchTyping(
  bot: Bot,
  harness: Harness,
  allowed: ReadonlySet<number>,
): Promise<(conversation: ConversationId) => void> {
  const running = new Map<ConversationId, ReturnType<typeof startTyping>>();
  let routes: Readonly<Record<string, ConversationId>> | undefined;
  let graph: TaskGraph | undefined;
  let closed = false;
  let scheduled = false;
  function stop(): void {
    closed = true;
    for (const typing of running.values()) typing.stop();
    running.clear();
  }
  const unsubscribe = harness.subscribeClose(stop);
  function end(): void {
    stop();
    unsubscribe();
  }
  function update(): void {
    if (scheduled || closed) return;
    scheduled = true;
    // 原生观察回调只记录状态；合并变更后异步发送，不阻塞提交。
    queueMicrotask(() => {
      scheduled = false;
      if (closed || routes === undefined || graph === undefined) return;
      const active = new Set(
        Object.values(graph.tasks)
          .filter((task) => !task.abortRequested && task.blocked === undefined)
          .map((task) => task.conversationId),
      );
      const current = new Set<ConversationId>();
      for (const [route, id] of Object.entries(routes)) {
        const [chat, thread] = route.split(":");
        const chatId = Number(chat);
        if (!allowed.has(chatId) || !active.has(id)) continue;
        current.add(id);
        if (!running.has(id))
          running.set(
            id,
            startTyping(bot, { chatId, threadId: Number(thread) || null }),
          );
      }
      for (const [id, typing] of running) {
        if (current.has(id)) continue;
        typing.stop();
        running.delete(id);
      }
    });
  }
  const state = await harness.observeDoc(
    TelegramState,
    {
      advance(call) {
        if (call.kind === "value") {
          routes = call.value.chats;
          update();
        }
      },
      end,
    },
    BACKGROUND_CONTEXT,
  );
  // attach 返回前可能已经收到更晚的变更，不能用初始快照覆盖它。
  routes ??= state?.value.chats ?? {};
  const tasks = await harness.observeTaskGraph(
    {
      advance(call) {
        if (call.kind === "value") {
          graph = call.value;
          update();
        }
      },
      end,
    },
    BACKGROUND_CONTEXT,
  );
  graph ??= tasks.value;
  update();
  return (conversation) => running.get(conversation)?.refresh();
}
