import { errorName, noopInfoLogger, type InfoLogger } from "../logging/logger";
import type { PiRpcEvent } from "../pi-rpc/types";

const TYPING_INTERVAL_MS = 2_000;
const TOOL_EDIT_INTERVAL_MS = 1_500;
const SETTLED_CLEANUP_DELAY_MS = 10_000;
const COMPACTION_ACTIVITY_ID = "amadeus:compaction";

export interface TelegramActivityApi {
  sendChatAction(chatId: number, action: "typing"): Promise<unknown>;
  sendMessage(
    chatId: number,
    text: string,
    options: { disable_notification: true },
  ): Promise<{ message_id: number }>;
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
  ): Promise<unknown>;
  deleteMessage(chatId: number, messageId: number): Promise<unknown>;
}

type ToolStatus = "running" | "done" | "failed";

interface ToolActivity {
  id: string;
  name: string;
  detail?: string;
  status: ToolStatus | undefined;
}

interface ChatActivity {
  tools: Map<string, ToolActivity>;
  operation: Promise<void>;
  typingTimer: ReturnType<typeof setInterval> | undefined;
  renderTimer: ReturnType<typeof setTimeout> | undefined;
  cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  toolMessageId: number | undefined;
  lastRenderAt: number;
  lastText: string;
}

export class TelegramActivityPresenter {
  readonly #api: TelegramActivityApi;
  readonly #logger: InfoLogger;
  readonly #chats = new Map<number, ChatActivity>();

  constructor(api: TelegramActivityApi, logger: InfoLogger = noopInfoLogger) {
    this.#api = api;
    this.#logger = logger;
  }

  startCompaction(chatId: number): void {
    this.#startRun(chatId);
    const activity = this.#getActivity(chatId);
    activity.tools.set(COMPACTION_ACTIVITY_ID, {
      id: COMPACTION_ACTIVITY_ID,
      name: "压缩中...",
      status: undefined,
    });
    this.#scheduleRender(chatId, activity, true);
  }

  handleEvent(chatId: number, event: PiRpcEvent): void {
    switch (event.type) {
      case "agent_start":
        this.#startRun(chatId);
        break;
      case "tool_execution_start":
        this.#upsertTool(
          chatId,
          event.toolCallId,
          event.toolName,
          event.args,
          "running",
        );
        break;
      case "tool_execution_update":
        this.#upsertTool(
          chatId,
          event.toolCallId,
          event.toolName,
          event.args,
          "running",
        );
        break;
      case "tool_execution_end":
        this.#upsertTool(
          chatId,
          event.toolCallId,
          event.toolName,
          undefined,
          event.isError ? "failed" : "done",
        );
        break;
      case "agent_settled":
        this.#settle(chatId);
        break;
      default:
        break;
    }
  }

  async finish(chatId: number): Promise<void> {
    const activity = this.#chats.get(chatId);
    if (!activity) {
      return;
    }
    this.#stopTyping(activity);
    this.#clearTimer(activity, "renderTimer");
    this.#clearTimer(activity, "cleanupTimer");
    await this.#enqueue(activity, async () => {
      if (activity.toolMessageId !== undefined) {
        await this.#api
          .deleteMessage(chatId, activity.toolMessageId)
          .catch(() => undefined);
        activity.toolMessageId = undefined;
      }
    });
    this.#chats.delete(chatId);
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.#chats.keys()].map((chatId) => this.finish(chatId)),
    );
  }

  #startRun(chatId: number): void {
    const activity = this.#getActivity(chatId);
    this.#clearTimer(activity, "cleanupTimer");
    this.#clearTimer(activity, "renderTimer");
    activity.tools.clear();
    activity.lastText = "";
    activity.lastRenderAt = 0;
    if (activity.toolMessageId !== undefined) {
      const messageId = activity.toolMessageId;
      activity.toolMessageId = undefined;
      void this.#enqueue(activity, async () => {
        await this.#api.deleteMessage(chatId, messageId).catch(() => undefined);
      }).catch(() => undefined);
    }
    this.#startTyping(chatId, activity);
  }

  #settle(chatId: number): void {
    const activity = this.#chats.get(chatId);
    if (!activity) {
      return;
    }
    this.#stopTyping(activity);
    if (activity.tools.size > 0) {
      this.#scheduleRender(chatId, activity, true);
    }
    this.#clearTimer(activity, "cleanupTimer");
    activity.cleanupTimer = setTimeout(() => {
      void this.finish(chatId).catch(() => undefined);
    }, SETTLED_CLEANUP_DELAY_MS);
  }

  #upsertTool(
    chatId: number,
    id: string,
    name: string,
    args: unknown,
    status: ToolStatus,
  ): void {
    const activity = this.#getActivity(chatId);
    this.#startTyping(chatId, activity);
    const existing = activity.tools.get(id);
    const detail = extractSafeDetail(args) ?? existing?.detail;
    activity.tools.set(id, {
      id,
      name: sanitizeOneLine(name, 48),
      ...(detail ? { detail } : {}),
      status,
    });
    this.#scheduleRender(
      chatId,
      activity,
      activity.toolMessageId === undefined,
    );
  }

  #scheduleRender(
    chatId: number,
    activity: ChatActivity,
    immediate: boolean,
  ): void {
    if (activity.renderTimer) {
      if (!immediate) {
        return;
      }
      clearTimeout(activity.renderTimer);
      activity.renderTimer = undefined;
    }

    const delay = immediate
      ? 0
      : Math.max(
          0,
          TOOL_EDIT_INTERVAL_MS - (Date.now() - activity.lastRenderAt),
        );
    activity.renderTimer = setTimeout(() => {
      activity.renderTimer = undefined;
      void this.#enqueue(activity, () => this.#render(chatId, activity)).catch(
        () => undefined,
      );
    }, delay);
  }

  async #render(chatId: number, activity: ChatActivity): Promise<void> {
    const text = renderTools(activity.tools);
    if (text.length === 0 || text === activity.lastText) {
      return;
    }

    const action =
      activity.toolMessageId === undefined
        ? "send_tool_status"
        : "edit_tool_status";
    try {
      if (activity.toolMessageId === undefined) {
        const sent = await this.#api.sendMessage(chatId, text, {
          disable_notification: true,
        });
        activity.toolMessageId = sent.message_id;
      } else {
        await this.#api.editMessageText(chatId, activity.toolMessageId, text);
      }
      activity.lastText = text;
      activity.lastRenderAt = Date.now();
      await this.#typingTick(chatId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("message is not modified")) {
        this.#logger.info("telegram_activity_failed", {
          chat_id: chatId,
          action,
          error_name: errorName(error),
          reason:
            action === "send_tool_status"
              ? "status_send_failed"
              : "status_edit_failed",
        });
      }
    }
  }

  #startTyping(chatId: number, activity: ChatActivity): void {
    if (activity.typingTimer) {
      return;
    }
    void this.#typingTick(chatId).catch(() => undefined);
    activity.typingTimer = setInterval(() => {
      void this.#typingTick(chatId).catch(() => undefined);
    }, TYPING_INTERVAL_MS);
  }

  #stopTyping(activity: ChatActivity): void {
    if (activity.typingTimer) {
      clearInterval(activity.typingTimer);
      activity.typingTimer = undefined;
    }
  }

  async #typingTick(chatId: number): Promise<void> {
    await this.#api.sendChatAction(chatId, "typing").catch((error: unknown) => {
      this.#logger.info("telegram_activity_failed", {
        chat_id: chatId,
        action: "typing",
        error_name: errorName(error),
        reason: "typing_failed",
      });
    });
  }

  #getActivity(chatId: number): ChatActivity {
    const existing = this.#chats.get(chatId);
    if (existing) {
      return existing;
    }
    const created: ChatActivity = {
      tools: new Map(),
      operation: Promise.resolve(),
      typingTimer: undefined,
      renderTimer: undefined,
      cleanupTimer: undefined,
      toolMessageId: undefined,
      lastRenderAt: 0,
      lastText: "",
    };
    this.#chats.set(chatId, created);
    return created;
  }

  async #enqueue(
    activity: ChatActivity,
    operation: () => Promise<void>,
  ): Promise<void> {
    const next = activity.operation.catch(() => undefined).then(operation);
    activity.operation = next;
    await next;
  }

  #clearTimer(
    activity: ChatActivity,
    key: "renderTimer" | "cleanupTimer",
  ): void {
    const timer = activity[key];
    if (timer) {
      clearTimeout(timer);
      activity[key] = undefined;
    }
  }
}

function renderTools(tools: ReadonlyMap<string, ToolActivity>): string {
  const visible = [...tools.values()].slice(-8);
  if (visible.length === 0) {
    return "";
  }
  return visible
    .map((tool) => {
      if (tool.status === undefined) {
        return tool.name;
      }
      const detail = tool.detail ? ` ${tool.detail}` : "";
      return `- ${tool.name}${detail} [${tool.status}]`;
    })
    .join("\n");
}

function extractSafeDetail(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return undefined;
  }
  for (const key of ["path", "filePath", "file_path"] as const) {
    if (key in args) {
      const value = Reflect.get(args, key);
      if (typeof value === "string") {
        return compactPath(value);
      }
    }
  }
  return undefined;
}

function compactPath(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  const compact =
    parts.length > 3 ? `.../${parts.slice(-3).join("/")}` : parts.join("/");
  return sanitizeOneLine(compact, 120);
}

function sanitizeOneLine(value: string, limit: number): string {
  return value
    .replace(/[\r\n\t]/g, " ")
    .trim()
    .slice(0, limit);
}
