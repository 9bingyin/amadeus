import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { contentText } from "@earendil-works/pi-ai/utils/text";
import {
  LiveDoc,
  type ConversationId,
  type Harness,
} from "@earendil-works/pi-durable";
import type { Api, Bot } from "grammy";
import { TelegramState } from "./conversations";
import { formatReply } from "./format";
import { Ingress, TelegramInput, type Destination } from "./inbound";

export type ReplyStream = {
  stop(conversation: ConversationId): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
};
type State = {
  destination: Destination;
  controller: AbortController;
  dirty: boolean;
  pending: Promise<void> | null;
  last: string;
  failed: string | null;
};
// grammY 使用旧版 AbortSignal 声明；原生信号在运行时兼容。
type TelegramSignal = NonNullable<Parameters<Api["sendMessageDraft"]>[4]>;

export async function openReplyStream(
  bot: Bot,
  harness: Harness,
  allowed: ReadonlySet<number>,
): Promise<ReplyStream> {
  const controller = new AbortController();
  const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
  const states = new Map<ConversationId, State>();
  using resources = new DisposableStack();
  function cancel(state: State): void {
    state.dirty = false;
    state.controller.abort();
    state.last = "";
  }
  function stop(): void {
    controller.abort();
    for (const state of states.values()) cancel(state);
  }
  resources.defer(stop);
  resources.defer(harness.subscribeClose(stop));

  function schedule(conversation: ConversationId, state: State): void {
    if (controller.signal.aborted) return;
    state.dirty = true;
    if (state.pending) return;
    // 提交观察回调只安排 UI 工作，不在 Session 提交线上读取状态或等待网络。
    state.pending = Promise.resolve()
      .then(async () => {
        while (state.dirty && !controller.signal.aborted) {
          state.dirty = false;
          if (state.controller.signal.aborted)
            state.controller = new AbortController();
          const signal = AbortSignal.any([
            controller.signal,
            state.controller.signal,
          ]);
          const readContext = withAbortSignal(signal, BACKGROUND_CONTEXT);
          let scope = "";
          try {
            const [live, ingress] = await Promise.all([
              harness.snapshot(LiveDoc, conversation, readContext),
              harness.snapshot(Ingress, conversation, readContext),
            ]);
            const run = live?.run;
            const generation = live?.generation;
            const message = generation?.message;
            const input = run?.inputs.at(-1);
            if (
              !run ||
              !generation ||
              !message ||
              input === undefined ||
              message.content.some((part) => part.type === "toolCall")
            )
              continue;
            const text = contentText(message.content);
            if (!text.trim()) continue;
            scope = `${run.taskId}:${generation.attempt}:${input}`;
            if (state.failed === scope) continue;
            const source = await harness.commit(async (tx) => {
              const submission = await tx.submission(input);
              if (
                submission?.type !== "input" ||
                submission.status !== "placed"
              )
                return undefined;
              return (await tx.entry(TelegramInput, submission.entry))?.data;
            }, readContext);
            if (
              !source ||
              !allowed.has(source.chatId) ||
              source.through !== ingress?.latest ||
              source.chatId !== state.destination.chatId ||
              source.threadId !== state.destination.threadId
            )
              continue;
            const preview = formatReply(text, true)[0];
            if (!preview) continue;
            const signature = scope + JSON.stringify(preview);
            if (signature === state.last) continue;
            signal.throwIfAborted();
            await bot.api.sendMessageDraft(
              source.chatId,
              run.taskId,
              preview.text,
              {
                ...(source.threadId === null
                  ? {}
                  : { message_thread_id: source.threadId }),
                entities: preview.entities,
              },
              signal as TelegramSignal,
            );
            state.last = signature;
          } catch (error) {
            if (!signal.aborted) {
              state.failed = scope;
              console.error(error);
            }
          }
        }
      })
      .finally(() => {
        state.pending = null;
        if (state.dirty && !controller.signal.aborted)
          schedule(conversation, state);
      });
  }
  function followRoutes(chats: Readonly<Record<string, ConversationId>>): void {
    for (const [route, conversation] of Object.entries(chats)) {
      if (controller.signal.aborted || states.has(conversation)) continue;
      const [chat, thread] = route.split(":");
      const chatId = Number(chat);
      if (!allowed.has(chatId)) continue;
      const stream: State = {
        destination: { chatId, threadId: Number(thread) || null },
        controller: new AbortController(),
        dirty: false,
        pending: null,
        last: "",
        failed: null,
      };
      states.set(conversation, stream);
      schedule(conversation, stream);
    }
  }
  const observation = harness.observeCommits({
    advance(publication) {
      if (controller.signal.aborted) return;
      for (const change of publication.changes) {
        if (change.type !== "document" || change.kind !== "change") continue;
        if (change.conversationId === undefined) continue;
        const state = states.get(change.conversationId);
        if (!state) continue;
        if (change.record.kind === Ingress.definition.kind) {
          cancel(state);
          schedule(change.conversationId, state);
        } else if (change.record.kind === LiveDoc.definition.kind) {
          if (
            change.value["run"] === undefined ||
            change.value["generation"] === undefined
          )
            cancel(state);
          else schedule(change.conversationId, state);
        }
      }
    },
    end: stop,
  });
  resources.defer(() => observation.detach());
  const routes = await harness.observeDoc(
    TelegramState,
    {
      advance(call) {
        if (call.kind === "value") followRoutes(call.value.chats);
      },
      end: stop,
    },
    context,
  );
  resources.defer(() => routes?.detach());
  followRoutes(routes?.value.chats ?? {});
  const cleanup = resources.move();
  const stream: ReplyStream = {
    async stop(conversation) {
      const state = states.get(conversation);
      if (!state) return;
      cancel(state);
      await state.pending;
    },
    async flush() {
      await Promise.all([...states.values()].map((state) => state.pending));
    },
    async close() {
      cleanup.dispose();
      await stream.flush();
    },
  };
  return stream;
}
