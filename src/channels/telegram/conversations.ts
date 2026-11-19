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
} from "@earendil-works/pi-durable";
import type { Context, Filter, MiddlewareFn } from "grammy";
import { z } from "zod";
import type { Agent } from "../../agent";
import { listSchedules } from "../../agent/schedule";
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

function relativeTimeLabel(ms: number, now: number): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const seconds = Math.round(abs / 1000);
  if (seconds === 0) return "now";
  let span: string;
  if (seconds < 60) {
    span = `${seconds}s`;
  } else {
    const minutes = Math.round(abs / 60_000);
    if (minutes < 60) {
      span = `${minutes}m`;
    } else {
      const hours = Math.round(abs / 3_600_000);
      span = hours < 24 ? `${hours}h` : `${Math.round(abs / 86_400_000)}d`;
    }
  }
  return diff >= 0 ? `in ${span}` : `${span} ago`;
}

function scheduleTimeLabel(ms: number, timeZone?: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  );
  const offset =
    parts["timeZoneName"] === "GMT"
      ? "UTC"
      : (parts["timeZoneName"] ?? "UTC").replace(/^GMT/u, "");
  const time =
    parts["second"] === "00"
      ? `${parts["hour"]}:${parts["minute"]}`
      : `${parts["hour"]}:${parts["minute"]}:${parts["second"]}`;
  return `${parts["year"]}-${parts["month"]}-${parts["day"]} ${time} ${offset}`;
}

function lastRunStatusLabel(
  run: Awaited<ReturnType<typeof listSchedules>>[number]["run"],
): string | undefined {
  if (!run || run.state.status !== "terminal") return undefined;
  const outcome = run.state.outcome;
  if (outcome.status === "aborted") return "Stopped";
  if (outcome.status !== "completed") return "Failed";
  const result = outcome.result;
  if (
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    typeof result["status"] === "string"
  ) {
    if (result["status"] === "failed") return "Failed";
    if (result["status"] === "interrupted") return "Interrupted";
  }
  return "Completed";
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
    const plans = await listSchedules(
      this.agent.stateDirectory,
      harness,
      conversation.id,
      context,
    );
    const lines: string[] = [];
    const states = {
      pending: "Waiting",
      running: "Running",
      sleeping: "Waiting",
      waiting: "Running",
      completing: "Finishing",
    };
    const now = Date.now();
    for (const [
      index,
      { meta, definition, controller: task, run },
    ] of plans.entries()) {
      const outcome = task?.state.outcome;
      const state =
        meta.status === "disabled"
          ? "Disabled"
          : !task
            ? "Waiting"
            : task.state.status !== "terminal"
              ? states[task.state.status]
              : outcome?.status === "completed"
                ? "Completed"
                : outcome?.status === "aborted"
                  ? "Stopped"
                  : "Failed";
      let when = "one-time";
      let timeZone: string | undefined;
      if (definition.when.kind === "cron") {
        when = `cron ${definition.when.expression.replace(/\s+/gu, " ")} @ ${definition.when.timezone}`;
        timeZone = definition.when.timezone;
      } else if (definition.when.kind === "every") {
        when = `every ${intervalLabel(definition.when.intervalMs)}`;
      }
      const lastStatus = lastRunStatusLabel(run);
      const lastAt = run?.endedAt ?? run?.startedAt;
      lines.push(
        [
          `${index + 1}. ${definition.name.replace(/\s+/gu, " ").trim()}`,
          `   ${"prompt" in definition ? "Agent" : "Script"} · ${state} · ${when}`,
          ...(task?.state.status === "sleeping"
            ? [
                `   Next: ${relativeTimeLabel(task.state.until, now)} (${scheduleTimeLabel(task.state.until, timeZone)})`,
              ]
            : []),
          ...(lastStatus
            ? [
                `   Last: ${lastAt !== undefined ? `${relativeTimeLabel(lastAt, now)} · ${lastStatus}` : lastStatus}`,
              ]
            : []),
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
      `Thinking: ${agent.thinkingLevel}`,
      `Status: ${status}`,
      `Context: ${contextUsage}`,
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
