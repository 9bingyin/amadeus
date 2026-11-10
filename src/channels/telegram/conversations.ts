import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  configure,
  defineDoc,
  defineDocFamily,
  InboxDoc,
  LiveDoc,
  UsageDoc,
  type Conversation,
  type ConversationId,
} from "@earendil-works/pi-durable";
import type { Context, Filter, MiddlewareFn } from "grammy";
import { z } from "zod";
import type { Agent } from "../../agent";
import { formatInboundMessage } from "./envelope";
import { BatchMessages, Ingress, Received, type BatchTask } from "./inbound";
import {
  isCommandMessage,
  messageContent,
  messageFiles,
  snapshotMessage,
} from "./metadata";

export type MessageContext = Filter<Context, "message">;
export const TelegramState = defineDoc<{
  botId: number | null;
  chats: Record<string, ConversationId>;
}>({
  kind: "amadeus.telegram",
  version: 1,
  scope: "session",
  initial: () => ({ botId: null, chats: {} }),
  checkpointWhen: () => true,
});
const CommandReceipt = defineDocFamily<{ accepted: boolean }, null>({
  kind: "amadeus.telegram.command",
  version: 1,
  family: true,
  scope: "session",
  initial: () => ({ accepted: false }),
  checkpointWhen: () => true,
});
const context = BACKGROUND_CONTEXT;

function routeKey(ctx: MessageContext): string {
  return `${ctx.chat.id}:${ctx.msg.message_thread_id ?? 0}`;
}

function requestId(ctx: MessageContext): string {
  return `${ctx.me.id}:${ctx.update.update_id}`;
}

export class TelegramConversations {
  constructor(
    private readonly agent: Agent,
    private readonly batch: BatchTask,
    private readonly inputWindowMs: number,
  ) {}

  async initialize(botId: number): Promise<void> {
    const conversations = await this.agent.harness.commit(async (tx) => {
      const state = await tx.doc(TelegramState);
      z.literal(state.botId ?? botId).parse(botId);
      state.botId = botId;
      return Object.values(state.chats);
    }, context);
    for (const id of conversations) {
      await (
        await this.agent.harness.conversation(id, context)
      )?.configure(this.agent.configuration, context);
    }
  }

  readonly command: MiddlewareFn<MessageContext> = async (ctx, next) => {
    const request = requestId(ctx);
    if (
      (await this.agent.harness.snapshot(CommandReceipt, request, context))
        ?.accepted
    )
      return;
    await next();
    await this.agent.harness.commit(async (tx) => {
      (await tx.doc(CommandReceipt, request, null)).accepted = true;
    }, context);
  };

  async conversation(ctx: MessageContext): Promise<Conversation> {
    const id = await this.agent.harness.commit(async (tx) => {
      const state = await tx.doc(TelegramState);
      const key = routeKey(ctx);
      const existing = state.chats[key];
      if (existing !== undefined) return existing;
      const created = await tx.createConversation({
        ownership: { kind: "ownerless" },
      });
      await configure(tx, created.id, this.agent.configuration);
      state.chats[key] = created.id;
      return created.id;
    }, context);
    // 路由与会话在同一事务中创建，且当前实现不会删除会话记录。
    return (await this.agent.harness.conversation(id, context))!;
  }

  async receive(ctx: MessageContext): Promise<void> {
    const command = isCommandMessage(ctx.msg);
    const content = messageContent(ctx.msg);
    const kinds = Object.keys(content);
    const trigger =
      !command && kinds.some((kind) => kind !== "text" || ctx.msg.text?.trim());
    const metadata = snapshotMessage(ctx.msg);
    const extra = Object.fromEntries(
      Object.entries(content).filter(
        ([key]) => key !== "text" && key !== "photo",
      ),
    );
    const mode = kinds.length ? "content" : "service";
    const message = {
      text:
        formatInboundMessage(ctx.msg) +
        (Object.keys(extra).length
          ? `\n[Telegram content]\n${JSON.stringify(extra)}`
          : ""),
      mode: command ? "command" : mode,
      metadata,
      files: messageFiles(content),
    } as const;
    const conversation = await this.conversation(ctx);
    const request = `telegram:received:${requestId(ctx)}`;
    await conversation.commit(async (tx) => {
      if (await tx.submissionByRequest(conversation.id, request)) return;
      const id = await conversation.submit(tx, {
        type: "write",
        requestId: request,
        entry: { kind: Received.kind, data: message },
      });
      if (!trigger) return;
      const ingress = await tx.doc(Ingress, conversation.id);
      const now = Date.now();
      if (ingress.collecting === null || ingress.collecting.until <= now) {
        const until = now + this.inputWindowMs;
        const batch = await tx.createTask(
          this.batch,
          {
            chatId: ctx.chat.id,
            threadId: ctx.msg.message_thread_id ?? null,
            until,
            after: ingress.tail,
          },
          { ownership: { kind: "conversation" } },
        );
        ingress.collecting = { id: batch, until };
        ingress.tail = batch;
      }
      (await tx.doc(BatchMessages, ingress.collecting.id)).receipts.push(id);
      ingress.latest = id;
    }, context);
  }

  async status(ctx: MessageContext): Promise<string> {
    const conversation = await this.conversation(ctx);
    const harness = this.agent.harness;
    const [agent, live, inbox, usage, ingress] = await Promise.all([
      conversation.agent(context),
      harness.snapshot(LiveDoc, conversation.id, context),
      harness.snapshot(InboxDoc, conversation.id, context),
      harness.snapshot(UsageDoc, conversation.id, context),
      harness.snapshot(Ingress, conversation.id, context),
    ]);
    const collecting = ingress?.collecting
      ? await harness.snapshot(BatchMessages, ingress.collecting.id, context)
      : undefined;
    const tokens = Object.values(usage?.models ?? {}).reduce(
      (sum, model) => sum + model.totalTokens,
      0,
    );
    let status = "空闲";
    if (live?.run) status = "正在处理";
    else if (ingress?.tail) status = "准备输入";
    return [
      `会话 ID：${conversation.id}`,
      `模型：${agent.model?.provider}/${agent.model?.modelId}`,
      `状态：${status}`,
      `输入准备：${ingress?.tail ? "进行中" : "无"}`,
      `收集消息：${collecting?.receipts.length ?? 0}`,
      `排队输入：${inbox?.items.filter((item) => item.mode !== "write").length ?? 0}`,
      `累计用量：${tokens} tokens`,
    ].join("\n");
  }
}
