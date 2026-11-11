import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import {
  defineDoc,
  LiveDoc,
  type ConversationId,
  type Harness,
  type ToolHooks,
} from "@earendil-works/pi-durable";
import type { Api, Bot } from "grammy";
import { TelegramState } from "./conversations";
import { TelegramInput, type Destination, type InputSource } from "./inbound";

const icons: Record<string, string> = {
  codemode: "\u{1f4e6}",
  read: "\u{1f4d6}",
  write: "\u270d\ufe0f",
  edit: "\u{1f4dd}",
};
const fields: Record<string, string> = {
  codemode: "code",
  bash: "command",
  read: "path",
  write: "path",
  edit: "path",
};

export function toolProgressLine(
  name: string,
  args: Readonly<Record<string, unknown>>,
  token?: string,
): string {
  function value(key: string): string {
    const item = args[key];
    return typeof item === "string" ? item.replace(/\s+/gu, " ").trim() : "";
  }
  let detail: string;
  if (name === "schedule") detail = value("name") || value("action");
  else {
    const field = fields[name];
    detail = field
      ? value(field)
      : (["query", "q", "text", "url", "path", "name", "prompt", "command"]
          .map(value)
          .find(Boolean) ?? "");
  }
  let label = name.replace(/^mcp__/, "");
  const separator = label.indexOf("__");
  const server = label.slice(0, separator);
  const tool = label.slice(separator + 2);
  if (separator > 0 && (tool === server || tool.startsWith(`${server}_`)))
    label = tool;
  const title =
    label
      .split(/[_\s]+/u)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ") || "Tool";
  const line = `${icons[name] ?? "\u{1f6e0}\ufe0f"} ${title}${detail ? `: ${detail}` : ""}`;
  const safe = token ? line.replaceAll(token, "[redacted]") : line;
  const chars = Array.from(safe);
  return chars.length > 60 ? chars.slice(0, 59).join("") + "…" : safe;
}

export const ProgressMessage = defineDoc<{ messageId: number | null }>({
  kind: "amadeus.telegram.progress",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ messageId: null }),
  checkpointWhen: () => true,
});

type Draft = {
  source: Destination & { through: InputSource["through"] | null };
  lines: string[];
  truncated: boolean;
  active: boolean;
  messageId: number | null;
  text: string;
  pending: Promise<void>;
};
export type ToolProgress = {
  beforeTool: ToolHooks["beforeTool"];
  clear(conversation: ConversationId): void;
  flush(): Promise<void>;
  close(): Promise<void>;
};
// grammY 使用旧版 AbortSignal 声明；运行时直接使用原生取消信号。
type TelegramSignal = NonNullable<Parameters<Api["deleteMessages"]>[2]>;

export async function openToolProgress(
  bot: Bot,
  harness: Harness,
  allowed: ReadonlySet<number>,
  refreshTyping: (conversation: ConversationId) => void,
): Promise<ToolProgress> {
  const drafts = new Map<ConversationId, Draft>();
  const controller = new AbortController();
  const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
  // 仅适配 grammY 的信号类型；不改变原生取消行为。
  const signal = controller.signal as TelegramSignal;
  let closed = false;
  function stop(): void {
    closed = true;
    controller.abort();
  }
  const unsubscribe = harness.subscribeClose(stop);

  function enqueue(draft: Draft, operation: () => Promise<void>): void {
    draft.pending = draft.pending
      .then(async () => {
        if (!closed) await operation();
      })
      .catch((error: unknown) => {
        if (!closed) console.error(error);
      });
  }
  function remove(conversation: ConversationId, draft: Draft): void {
    draft.active = false;
    enqueue(draft, async () => {
      const id = draft.messageId;
      if (id === null) return;
      // 批量删除原生跳过已不存在的消息，崩溃后可重复清理。
      await bot.api.deleteMessages(draft.source.chatId, [id], signal);
      await harness.commit(async (tx) => {
        const state = await tx.doc(ProgressMessage, conversation);
        if (state.messageId === id) state.messageId = null;
      }, context);
      draft.messageId = null;
    });
  }
  function add(
    conversation: ConversationId,
    source: InputSource,
    line: string,
  ): void {
    if (closed || !allowed.has(source.chatId)) return;
    let draft = drafts.get(conversation);
    if (!draft?.active || draft.source.through !== source.through) {
      if (draft?.active) remove(conversation, draft);
      draft = {
        source,
        lines: [],
        truncated: false,
        active: true,
        messageId: null,
        text: "",
        pending: draft?.pending ?? Promise.resolve(),
      };
      drafts.set(conversation, draft);
    }
    draft.lines.push(line);
    if (draft.lines.length > 15) {
      draft.lines.shift();
      draft.truncated = true;
    }
    const current = draft;
    enqueue(current, async () => {
      if (!current.active) return;
      const text = [...(current.truncated ? ["…"] : []), ...current.lines].join(
        "\n",
      );
      if (text === current.text) return;
      if (current.messageId === null) {
        const message = await bot.api.sendMessage(
          source.chatId,
          text,
          {
            ...(source.threadId === null
              ? {}
              : { message_thread_id: source.threadId }),
            disable_notification: true,
            link_preview_options: { is_disabled: true },
          },
          signal,
        );
        current.messageId = message.message_id;
        await harness.commit(async (tx) => {
          (await tx.doc(ProgressMessage, conversation)).messageId =
            message.message_id;
        }, context);
        if (current.active) refreshTyping(conversation);
      } else
        await bot.api.editMessageText(
          source.chatId,
          current.messageId,
          text,
          {
            link_preview_options: { is_disabled: true },
          },
          signal,
        );
      current.text = text;
    });
  }
  const state = await harness.snapshot(TelegramState, context);
  // Bot 身份校验随后由 conversations.initialize 执行；此前不能用另一个 Bot 清理消息。
  const routes = state?.botId === bot.botInfo.id ? state.chats : {};
  for (const [route, conversation] of Object.entries(routes)) {
    const [chat, thread] = route.split(":");
    const chatId = Number(chat);
    if (!allowed.has(chatId)) continue;
    const saved = (
      await harness.snapshot(ProgressMessage, conversation, context)
    )?.messageId;
    if (saved == null) continue;
    const draft: Draft = {
      source: {
        chatId,
        threadId: Number(thread) || null,
        through: null,
      },
      lines: [],
      truncated: false,
      active: false,
      messageId: saved,
      text: "",
      pending: Promise.resolve(),
    };
    drafts.set(conversation, draft);
    remove(conversation, draft);
  }
  const observation = harness.observeCommits({
    advance(publication) {
      if (closed) return;
      for (const change of publication.changes) {
        if (
          change.type !== "document" ||
          change.kind !== "change" ||
          change.record.kind !== LiveDoc.definition.kind ||
          change.conversationId === undefined ||
          change.value["run"] !== undefined
        )
          continue;
        const draft = drafts.get(change.conversationId);
        if (draft) remove(change.conversationId, draft);
      }
    },
    end: stop,
  });
  const progress: ToolProgress = {
    async beforeTool(call, api, hookContext): Promise<undefined> {
      if (closed || call.parent) return;
      try {
        const live = await api.snapshot(
          LiveDoc,
          api.conversationId,
          hookContext,
        );
        const id = live?.run?.inputs.at(-1);
        if (id === undefined) return;
        const submission = await (
          await harness.submission(id, hookContext)
        )?.status(hookContext);
        if (submission?.type !== "input" || submission.status !== "placed")
          return;
        const input = await api.entry(
          TelegramInput,
          submission.entry,
          hookContext,
        );
        if (input && !hookContext.abortSignal?.aborted) {
          const line = toolProgressLine(call.name, call.arguments, bot.token);
          add(api.conversationId, input.data, line);
        }
      } catch (error) {
        if (!closed && !hookContext.abortSignal?.aborted) console.error(error);
      }
      return undefined;
    },
    clear(conversation) {
      const draft = drafts.get(conversation);
      if (draft) remove(conversation, draft);
    },
    async flush() {
      await Promise.all([...drafts.values()].map((draft) => draft.pending));
    },
    async close() {
      stop();
      observation.detach();
      unsubscribe();
      await progress.flush();
    },
  };
  return progress;
}
