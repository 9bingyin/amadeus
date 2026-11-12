import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  configure,
  defineDoc,
  defineDocFamily,
  InboxDoc,
  LiveDoc,
  type Conversation,
  type ConversationId,
  type TaskId,
} from "@earendil-works/pi-durable";
import type { Context, Filter, MiddlewareFn } from "grammy";
import { z } from "zod";
import type { Agent } from "../../agent";
import { Schedules } from "../../agent/schedule";
import { readScheduleFile, schedulePath } from "../../agent/schedule/files";
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

function intervalLabel(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

function tokenLabel(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
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
    const receipt = await conversation.commit(async (tx) => {
      if (await tx.submissionByRequest(conversation.id, request)) return;
      const id = await conversation.submit(tx, {
        type: "write",
        requestId: request,
        entry: { kind: Received.kind, data: message },
      });
      if (!trigger) return id;
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
      return id;
    }, context);
    if (receipt !== undefined)
      console.info(
        `Telegram message received: conversation=${conversation.id} chat=${ctx.chat.id} message=${ctx.msg.message_id} kind=${message.mode}`,
      );
  }

  async schedules(ctx: MessageContext): Promise<string> {
    const conversation = await this.conversation(ctx);
    const harness = this.agent.harness;
    const catalog = await harness.snapshot(Schedules, conversation.id, context);
    const lines: string[] = [];
    const states = {
      pending: "Waiting",
      running: "Running",
      sleeping: "Waiting",
      waiting: "Running",
      completing: "Finishing",
    };
    for (const [id, job] of Object.entries(catalog?.jobs ?? {})) {
      // 目录键来自原生 TaskId，目录与任务原子创建；原生任务记录不会硬删除。
      const task = (await harness.getTask(Number(id) as TaskId, context))!;
      if (task.state.status === "terminal") continue;
      const path = schedulePath(this.agent.stateDirectory, task.id);
      const definition = await readScheduleFile(path);
      let when = "One-time";
      if (definition.when.kind === "cron")
        when = `Cron ${definition.when.expression.replace(/\s+/gu, " ")} · ${definition.when.timezone}`;
      else if (definition.when.kind === "every")
        when = `Every ${intervalLabel(definition.when.intervalMs)}`;
      lines.push(
        [
          `#${id} ${definition.name.replace(/\s+/gu, " ")} · ${job.worker === undefined ? "Script" : "Agent"}`,
          `${when} · ${states[task.state.status]}`,
          ...(task.state.status === "sleeping"
            ? [
                `Next: ${new Date(task.state.until)
                  .toISOString()
                  .replace("T", " ")
                  .replace(/\.\d{3}Z$/u, " UTC")}`,
              ]
            : []),
          `File: ${path}`,
        ].join("\n"),
      );
    }
    return lines.length
      ? `Schedules (${lines.length})\n\n${lines.join("\n\n")}`
      : "No schedules.";
  }

  async status(ctx: MessageContext): Promise<string> {
    const conversation = await this.conversation(ctx);
    const harness = this.agent.harness;
    const [agent, live, inbox, view, ingress] = await Promise.all([
      conversation.agent(context),
      harness.snapshot(LiveDoc, conversation.id, context),
      harness.snapshot(InboxDoc, conversation.id, context),
      conversation.context(context),
      harness.snapshot(Ingress, conversation.id, context),
    ]);
    const collecting = ingress?.collecting
      ? await harness.snapshot(BatchMessages, ingress.collecting.id, context)
      : undefined;
    const model = agent.model
      ? this.agent.models.getModel(agent.model.provider, agent.model.modelId)
      : undefined;
    let contextUsage = "?/?";
    if (model && model.contextWindow > 0) {
      const head = view.head?.id;
      // 压缩/重置保留的旧回复不能标定新上下文；等待 head 之后的有效用量。
      const known =
        head === undefined ||
        estimateContextTokens(
          view.entries.flatMap((entry, index) =>
            entry.id > head ? (view.contributions[index] ?? []) : [],
          ),
        ).lastUsageIndex !== null;
      const percent = known
        ? `${((estimateContextTokens(view.messages).tokens / model.contextWindow) * 100).toFixed(1)}%`
        : "?";
      contextUsage = `${percent}/${tokenLabel(model.contextWindow)}`;
    }
    let status = "Idle";
    if (live?.run) status = "Working";
    else if (live?.compactions?.length) status = "Compacting";
    else if (ingress?.tail) status = "Preparing";
    const queued =
      inbox?.items.filter((item) => item.mode !== "write").length ?? 0;
    const count = collecting?.receipts.length ?? 0;
    return [
      `Model: ${agent.model ? `${agent.model.provider}/${agent.model.modelId}` : "unknown"}`,
      `Status: ${status}`,
      `Context: ${contextUsage}`,
      `Session: ${conversation.id}`,
      ...(ingress?.tail ? ["Preparing input"] : []),
      ...(count
        ? [`Collecting: ${count} ${count === 1 ? "message" : "messages"}`]
        : []),
      ...(queued
        ? [`Queued: ${queued} ${queued === 1 ? "item" : "items"}`]
        : []),
      ...(live?.compactions?.length
        ? [`Compactions: ${live.compactions.length}`]
        : []),
      ...(live?.compactionFailure
        ? [`Last compaction error: ${live.compactionFailure.error}`]
        : []),
    ].join("\n");
  }
}
