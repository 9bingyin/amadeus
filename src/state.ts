import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  IndexedTelegramMessage,
  TelegramAttachment,
  TelegramForwardOrigin,
  TelegramMessageContent,
} from "./telegram/types";

export interface PiSessionPointer {
  id: string;
  file: string;
  materialized?: boolean;
}

export interface ChatState {
  session?: PiSessionPointer;
  messageOrder: number[];
  messages: Record<string, IndexedTelegramMessage>;
  seenMessageOrder?: number[];
  outboundToolCallOrder?: string[];
}

export interface AppState {
  version: 1;
  lastUpdateId?: number;
  chats: Record<string, ChatState>;
}

const EMPTY_STATE: AppState = {
  version: 1,
  chats: {},
};

export class StateStore {
  readonly #path: string;
  #state: AppState;
  #writeQueue: Promise<void> = Promise.resolve();

  private constructor(path: string, state: AppState) {
    this.#path = path;
    this.#state = state;
  }

  static async open(path: string): Promise<StateStore> {
    await mkdir(dirname(path), { recursive: true });

    let state = structuredClone(EMPTY_STATE);
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (!isAppState(parsed)) {
        throw new Error("状态文件结构无效");
      }
      state = parsed;
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw new Error(`无法读取状态文件 ${path}`, { cause: error });
      }
    }

    return new StateStore(path, state);
  }

  snapshot(): AppState {
    return structuredClone(this.#state);
  }

  async update(mutator: (state: AppState) => void): Promise<void> {
    const operation = this.#writeQueue
      .catch(() => undefined)
      .then(async () => {
        const next = structuredClone(this.#state);
        mutator(next);
        await this.#persist(next);
        this.#state = next;
      });

    this.#writeQueue = operation;
    await operation;
  }

  async #persist(state: AppState): Promise<void> {
    const tempPath = `${this.#path}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tempPath, this.#path);
  }
}

export function getOrCreateChatState(
  state: AppState,
  chatId: number,
): ChatState {
  const key = String(chatId);
  const existing = state.chats[key];
  if (existing) {
    return existing;
  }

  const created: ChatState = {
    messageOrder: [],
    messages: {},
    seenMessageOrder: [],
  };
  state.chats[key] = created;
  return created;
}

export function hasSeenMessage(
  chat: ChatState | undefined,
  messageId: number,
): boolean {
  return (
    chat?.seenMessageOrder?.includes(messageId) === true ||
    chat?.messages[String(messageId)] !== undefined
  );
}

export function markMessageSeen(
  chat: ChatState,
  messageId: number,
  limit = 1_000,
): void {
  const seen = chat.seenMessageOrder ?? [];
  if (!seen.includes(messageId)) {
    seen.push(messageId);
  }
  while (seen.length > limit) {
    seen.shift();
  }
  chat.seenMessageOrder = seen;
}

export function reserveOutboundToolCall(
  chat: ChatState,
  sessionId: string,
  toolCallId: string,
): boolean {
  const key = JSON.stringify([sessionId, toolCallId]);
  const order = chat.outboundToolCallOrder ?? [];
  if (order.includes(key)) {
    return false;
  }
  order.push(key);
  chat.outboundToolCallOrder = order;
  return true;
}

export function indexMessage(
  chat: ChatState,
  message: IndexedTelegramMessage,
  limit = 500,
): void {
  const key = String(message.messageId);
  if (!(key in chat.messages)) {
    chat.messageOrder.push(message.messageId);
  }
  chat.messages[key] = message;

  while (chat.messageOrder.length > limit) {
    const oldest = chat.messageOrder.shift();
    if (oldest !== undefined) {
      delete chat.messages[String(oldest)];
    }
  }
}

function isAppState(value: unknown): value is AppState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.chats)) {
    return false;
  }
  if (value.lastUpdateId !== undefined && !isSafeInteger(value.lastUpdateId)) {
    return false;
  }
  return Object.values(value.chats).every(isChatState);
}

function isChatState(value: unknown): value is ChatState {
  if (
    !isRecord(value) ||
    !Array.isArray(value.messageOrder) ||
    !isRecord(value.messages)
  ) {
    return false;
  }
  if (!value.messageOrder.every(isSafeInteger)) {
    return false;
  }
  if (value.session !== undefined && !isPiSessionPointer(value.session)) {
    return false;
  }
  if (
    value.seenMessageOrder !== undefined &&
    (!Array.isArray(value.seenMessageOrder) ||
      !value.seenMessageOrder.every(isSafeInteger))
  ) {
    return false;
  }
  if (
    value.outboundToolCallOrder !== undefined &&
    (!Array.isArray(value.outboundToolCallOrder) ||
      !value.outboundToolCallOrder.every(isNonEmptyString))
  ) {
    return false;
  }
  return Object.values(value.messages).every(isIndexedMessage);
}

function isPiSessionPointer(value: unknown): value is PiSessionPointer {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.file) &&
    (value.materialized === undefined ||
      typeof value.materialized === "boolean")
  );
}

function isIndexedMessage(value: unknown): value is IndexedTelegramMessage {
  if (
    !isRecord(value) ||
    !isSafeInteger(value.messageId) ||
    (value.role !== "user" && value.role !== "assistant") ||
    !isNonEmptyString(value.piSessionId) ||
    !isNonEmptyString(value.sentAt) ||
    typeof value.text !== "string" ||
    (value.piEntryId !== undefined && !isNonEmptyString(value.piEntryId)) ||
    (value.content !== undefined && !isMessageContent(value.content)) ||
    (value.mediaGroupId !== undefined &&
      !isNonEmptyString(value.mediaGroupId)) ||
    !Array.isArray(value.attachments) ||
    !value.attachments.every(isAttachment)
  ) {
    return false;
  }
  return value.forward === undefined || isForwardOrigin(value.forward);
}

function isAttachment(value: unknown): value is TelegramAttachment {
  if (!isAttachmentBase(value)) {
    return false;
  }

  switch (value.kind) {
    case "animation":
    case "live_photo":
    case "video":
      return (
        isNonNegativeInteger(value.width) &&
        isNonNegativeInteger(value.height) &&
        isNonNegativeInteger(value.duration) &&
        (value.kind !== "video" ||
          value.startTimestamp === undefined ||
          isNonNegativeInteger(value.startTimestamp))
      );
    case "audio":
      return (
        isNonNegativeInteger(value.duration) &&
        optionalString(value.performer) &&
        optionalString(value.title)
      );
    case "document":
      return true;
    case "photo":
      return (
        isNonNegativeInteger(value.width) && isNonNegativeInteger(value.height)
      );
    case "sticker":
      return (
        isNonNegativeInteger(value.width) &&
        isNonNegativeInteger(value.height) &&
        ["regular", "mask", "custom_emoji"].includes(
          String(value.stickerType),
        ) &&
        ["static", "animated", "video"].includes(String(value.format)) &&
        optionalString(value.emoji) &&
        optionalString(value.setName)
      );
    case "video_note":
      return (
        isNonNegativeInteger(value.length) &&
        isNonNegativeInteger(value.duration)
      );
    case "voice":
      return isNonNegativeInteger(value.duration);
    default:
      return false;
  }
}

function isAttachmentBase(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    isNonEmptyString(value.fileId) &&
    isNonEmptyString(value.fileUniqueId) &&
    optionalString(value.fileName) &&
    optionalString(value.mimeType) &&
    (value.size === undefined || isNonNegativeInteger(value.size)) &&
    (value.source === undefined ||
      ["message", "paid_media", "poll", "game", "rich_message"].includes(
        String(value.source),
      )) &&
    (value.sourceSection === undefined ||
      ["description", "explanation", "option"].includes(
        String(value.sourceSection),
      )) &&
    (value.sourceSection === undefined || value.source === "poll") &&
    (value.sourceIndex === undefined ||
      isNonNegativeInteger(value.sourceIndex)) &&
    (value.localPath === undefined || isNonEmptyString(value.localPath)) &&
    (value.unavailableReason === undefined ||
      [
        "telegram_public_api_limit",
        "download_failed",
        "content_unavailable",
      ].includes(String(value.unavailableReason))) &&
    !(value.localPath !== undefined && value.unavailableReason !== undefined)
  );
}

function isMessageContent(value: unknown): value is TelegramMessageContent {
  if (!isRecord(value) || !isNonEmptyString(value.kind)) {
    return false;
  }

  switch (value.kind) {
    case "unavailable":
      return (
        [
          "text",
          "rich_message",
          "animation",
          "audio",
          "document",
          "live_photo",
          "paid_media",
          "photo",
          "sticker",
          "story",
          "video",
          "video_note",
          "voice",
          "contact",
          "dice",
          "game",
          "poll",
          "venue",
          "location",
          "checklist",
        ].includes(String(value.contentKind)) &&
        Array.isArray(value.reasons) &&
        value.reasons.length > 0 &&
        optionalUnavailableReasons(value.reasons)
      );
    case "text":
    case "animation":
    case "audio":
    case "document":
    case "live_photo":
    case "photo":
    case "sticker":
    case "video":
    case "video_note":
    case "voice":
      return true;
    case "rich_message":
      return (
        Array.isArray(value.blockTypes) &&
        value.blockTypes.every(isNonEmptyString) &&
        (value.unavailableBlockCount === undefined ||
          isNonNegativeInteger(value.unavailableBlockCount)) &&
        optionalUnavailableReasons(value.unavailableReasons)
      );
    case "paid_media":
      return (
        isNonNegativeInteger(value.starCount) &&
        isNonNegativeInteger(value.itemCount) &&
        isNonNegativeInteger(value.unavailableItemCount) &&
        optionalUnavailableReasons(value.unavailableReasons) &&
        (value.previews === undefined ||
          (Array.isArray(value.previews) &&
            value.previews.every(isPaidPreview)))
      );
    case "story":
      return isSafeInteger(value.chatId) && isNonNegativeInteger(value.storyId);
    case "contact":
      return (
        typeof value.phoneNumber === "string" &&
        isNonEmptyString(value.firstName) &&
        optionalString(value.lastName) &&
        (value.userId === undefined || isSafeInteger(value.userId)) &&
        optionalString(value.vcard)
      );
    case "dice":
      return isNonEmptyString(value.emoji) && isNonNegativeInteger(value.value);
    case "game":
      return (
        isNonEmptyString(value.title) &&
        typeof value.description === "string" &&
        typeof value.text === "string"
      );
    case "poll":
      return (
        isNonEmptyString(value.question) &&
        Array.isArray(value.options) &&
        value.options.every(isPollOption) &&
        isNonNegativeInteger(value.totalVoterCount) &&
        typeof value.closed === "boolean" &&
        typeof value.anonymous === "boolean" &&
        (value.pollType === "regular" || value.pollType === "quiz") &&
        typeof value.multipleAnswers === "boolean" &&
        typeof value.allowsRevoting === "boolean" &&
        typeof value.membersOnly === "boolean" &&
        optionalIntegerArray(value.correctOptionIds) &&
        optionalStringArray(value.countryCodes) &&
        optionalString(value.explanation) &&
        optionalString(value.description) &&
        (value.openPeriod === undefined ||
          isNonNegativeInteger(value.openPeriod)) &&
        (value.closeDate === undefined ||
          isNonNegativeInteger(value.closeDate)) &&
        (value.media === undefined ||
          (Array.isArray(value.media) &&
            value.media.every(isPollEmbeddedContent)))
      );
    case "venue":
      return (
        isFiniteNumber(value.latitude) &&
        isFiniteNumber(value.longitude) &&
        isNonEmptyString(value.title) &&
        typeof value.address === "string" &&
        optionalString(value.foursquareId) &&
        optionalString(value.foursquareType) &&
        optionalString(value.googlePlaceId) &&
        optionalString(value.googlePlaceType)
      );
    case "location":
      return (
        isFiniteNumber(value.latitude) &&
        isFiniteNumber(value.longitude) &&
        optionalFiniteNumber(value.horizontalAccuracy) &&
        optionalFiniteNumber(value.livePeriod) &&
        optionalFiniteNumber(value.heading) &&
        optionalFiniteNumber(value.proximityAlertRadius)
      );
    case "checklist":
      return (
        isNonEmptyString(value.title) &&
        Array.isArray(value.tasks) &&
        value.tasks.every(isChecklistTask) &&
        typeof value.othersCanAddTasks === "boolean" &&
        typeof value.othersCanMarkTasksDone === "boolean"
      );
    default:
      return false;
  }
}

function isPaidPreview(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.index) &&
    optionalFiniteNumber(value.width) &&
    optionalFiniteNumber(value.height) &&
    optionalFiniteNumber(value.duration)
  );
}

function isPollEmbeddedContent(value: unknown): boolean {
  if (
    !isRecord(value) ||
    (value.section !== "description" &&
      value.section !== "explanation" &&
      value.section !== "option") ||
    (value.section === "option"
      ? !isNonNegativeInteger(value.optionIndex)
      : value.optionIndex !== undefined)
  ) {
    return false;
  }

  switch (value.kind) {
    case "link":
      return isNonEmptyString(value.url);
    case "location":
      return (
        isFiniteNumber(value.latitude) &&
        isFiniteNumber(value.longitude) &&
        optionalFiniteNumber(value.horizontalAccuracy)
      );
    case "venue":
      return (
        isFiniteNumber(value.latitude) &&
        isFiniteNumber(value.longitude) &&
        isNonEmptyString(value.title) &&
        typeof value.address === "string"
      );
    default:
      return false;
  }
}

function isPollOption(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.text) &&
    isNonNegativeInteger(value.voterCount)
  );
}

function isChecklistTask(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.id) &&
    isNonEmptyString(value.text) &&
    typeof value.completed === "boolean" &&
    (value.completionDate === undefined ||
      isNonNegativeInteger(value.completionDate)) &&
    (value.completedByUserId === undefined ||
      isSafeInteger(value.completedByUserId)) &&
    (value.completedByChatId === undefined ||
      isSafeInteger(value.completedByChatId))
  );
}

function isForwardOrigin(value: unknown): value is TelegramForwardOrigin {
  if (!isRecord(value) || !isNonEmptyString(value.sentAt)) {
    return false;
  }

  switch (value.kind) {
    case "user":
      return (
        isSafeInteger(value.id) &&
        isNonEmptyString(value.displayName) &&
        (value.username === undefined || isNonEmptyString(value.username)) &&
        typeof value.isBot === "boolean"
      );
    case "hidden_user":
      return isNonEmptyString(value.displayName);
    case "chat":
      return (
        isSafeInteger(value.id) &&
        isNonEmptyString(value.title) &&
        (value.username === undefined || isNonEmptyString(value.username))
      );
    case "channel":
      return (
        isSafeInteger(value.id) &&
        isNonEmptyString(value.title) &&
        (value.username === undefined || isNonEmptyString(value.username)) &&
        isSafeInteger(value.messageId)
      );
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalUnavailableReasons(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every((reason) =>
        [
          "content_unavailable",
          "unsupported_nested_type",
          "missing_fields",
        ].includes(String(reason)),
      ))
  );
}

function optionalIntegerArray(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every(isNonNegativeInteger))
  );
}

function optionalStringArray(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every(isNonEmptyString))
  );
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
