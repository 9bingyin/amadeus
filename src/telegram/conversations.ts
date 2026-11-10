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
import type { Agent } from "../agent";
import { TelegramInput, type DeliveryTask } from "./delivery";

export type MessageContext = Filter<Context, "message">;
const State = defineDoc<{
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
    private readonly delivery: DeliveryTask,
  ) {}

  async initialize(botId: number): Promise<void> {
    const conversations = await this.agent.harness.commit(async (tx) => {
      const state = await tx.doc(State);
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
      const state = await tx.doc(State);
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

  async submit(ctx: MessageContext, text: string): Promise<void> {
    const conversation = await this.conversation(ctx);
    const request = requestId(ctx);
    const destination = {
      chatId: ctx.chat.id,
      threadId: ctx.msg.message_thread_id ?? null,
    };
    await conversation.commit(async (tx) => {
      // 同时去重伴随的错误通知任务，而不另存文本输入的 Receipt。
      if (await tx.submissionByRequest(conversation.id, request)) return;
      const id = await conversation.submit(tx, {
        type: "input",
        content: text,
        requestId: request,
        entry: { kind: TelegramInput.kind, data: destination },
      });
      await tx.createTask(
        this.delivery,
        { ...destination, kind: "failure", id },
        { ownership: { kind: "conversation" }, background: true },
      );
    }, context);
  }

  async status(ctx: MessageContext): Promise<string> {
    const conversation = await this.conversation(ctx);
    const harness = this.agent.harness;
    const [agent, live, inbox, usage] = await Promise.all([
      conversation.agent(context),
      harness.snapshot(LiveDoc, conversation.id, context),
      harness.snapshot(InboxDoc, conversation.id, context),
      harness.snapshot(UsageDoc, conversation.id, context),
    ]);
    const tokens = Object.values(usage?.models ?? {}).reduce(
      (sum, model) => sum + model.totalTokens,
      0,
    );
    return [
      `会话 ID：${conversation.id}`,
      `模型：${agent.model?.provider}/${agent.model?.modelId}`,
      `状态：${live?.run ? "正在处理" : "空闲"}`,
      `排队输入：${inbox?.items.filter((item) => item.mode !== "write").length ?? 0}`,
      `累计用量：${tokens} tokens`,
    ].join("\n");
  }
}
