import { AbortController, type AbortSignal } from "abort-controller";
import { randomInt } from "node:crypto";
import type {
  PiTextStreamEvent,
  PiTextStreamGeneration,
} from "../bridge/chat-agent";
import { errorName, noopInfoLogger, type InfoLogger } from "../logging/logger";

const TELEGRAM_DRAFT_LIMIT = 4096;
const DEFAULT_DRAFT_INTERVAL_MS = 1_500;
const DEFAULT_DRAFT_ID = 1;
const MINIMUM_DRAFT_TEXT_LENGTH = 4;
const MAXIMUM_DRAFT_ID = 2_147_483_647;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export interface TelegramDraftApi {
  sendMessageDraft(
    chatId: number,
    draftId: number,
    text: string,
    other?: undefined,
    signal?: AbortSignal,
  ): Promise<true>;
}

interface DraftState {
  chatId: number;
  generation: PiTextStreamGeneration;
  replyToMessageId: number;
  draftId: number;
  text: string;
  lastSentText: string | undefined;
  firstEligibleAt: number | undefined;
  lastAttemptAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  sendPending: boolean;
  requestController: AbortController | undefined;
  failed: boolean;
}

export interface TelegramDraftStreamerOptions {
  intervalMs?: number;
  draftId?: number;
  requestTimeoutMs?: number;
}

export class TelegramDraftStreamer {
  readonly #api: TelegramDraftApi;
  readonly #logger: InfoLogger;
  readonly #intervalMs: number;
  readonly #requestTimeoutMs: number;
  #nextDraftId: number;
  readonly #states = new Map<number, DraftState>();
  readonly #operations = new Map<number, Promise<void>>();

  constructor(
    api: TelegramDraftApi,
    logger: InfoLogger = noopInfoLogger,
    options: TelegramDraftStreamerOptions = {},
  ) {
    this.#api = api;
    this.#logger = logger;
    this.#intervalMs = options.intervalMs ?? DEFAULT_DRAFT_INTERVAL_MS;
    this.#requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#nextDraftId =
      options.draftId ?? randomInt(DEFAULT_DRAFT_ID, MAXIMUM_DRAFT_ID);
  }

  handle(chatId: number, event: PiTextStreamEvent): void {
    switch (event.type) {
      case "start":
        this.#start(chatId, event.generation, event.replyToMessageId);
        break;
      case "delta":
        this.#push(chatId, event.generation, event.text);
        break;
      case "abort":
        this.abort(chatId, event.generation);
        break;
      default: {
        const exhaustive: never = event;
        throw new Error(`未知 Telegram draft 事件：${String(exhaustive)}`);
      }
    }
  }

  async finish(
    chatId: number,
    generation: PiTextStreamGeneration,
  ): Promise<void> {
    const state = this.#states.get(chatId);
    if (!state || !sameGeneration(state.generation, generation)) {
      return;
    }

    this.#clearTimer(state);
    await this.#operations.get(chatId)?.catch(() => undefined);

    if (
      this.#states.get(chatId) === state &&
      !state.failed &&
      visibleTextLength(state.text) >= MINIMUM_DRAFT_TEXT_LENGTH
    ) {
      this.#clearTimer(state);
      this.#queueDraft(state, draftPreview(state.text));
      await this.#operations.get(chatId)?.catch(() => undefined);
    }

    this.abort(chatId, generation);
  }

  async abortChat(chatId: number): Promise<void> {
    this.abort(chatId);
    await this.#operations.get(chatId)?.catch(() => undefined);
  }

  abort(chatId: number, generation?: PiTextStreamGeneration): void {
    const state = this.#states.get(chatId);
    if (
      !state ||
      (generation && !sameGeneration(state.generation, generation))
    ) {
      return;
    }
    this.#states.delete(chatId);
    state.requestController?.abort();
    state.requestController = undefined;
    this.#clearTimer(state);
  }

  #clearTimer(state: DraftState): void {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
  }

  async close(): Promise<void> {
    for (const chatId of this.#states.keys()) {
      this.abort(chatId);
    }
    await Promise.allSettled(this.#operations.values());
    this.#operations.clear();
  }

  #start(
    chatId: number,
    generation: PiTextStreamGeneration,
    replyToMessageId: number,
  ): void {
    this.abort(chatId);
    const state: DraftState = {
      chatId,
      generation,
      replyToMessageId,
      draftId: this.#takeDraftId(),
      text: "",
      lastSentText: undefined,
      firstEligibleAt: undefined,
      lastAttemptAt: 0,
      timer: undefined,
      sendPending: false,
      requestController: undefined,
      failed: false,
    };
    this.#states.set(chatId, state);
  }

  #push(
    chatId: number,
    generation: PiTextStreamGeneration,
    text: string,
  ): void {
    const state = this.#states.get(chatId);
    if (
      !state ||
      !sameGeneration(state.generation, generation) ||
      state.failed
    ) {
      return;
    }
    state.text += text;
    if (
      state.firstEligibleAt === undefined &&
      visibleTextLength(state.text) >= MINIMUM_DRAFT_TEXT_LENGTH
    ) {
      state.firstEligibleAt = Date.now();
    }
    this.#scheduleDraft(state);
  }

  #takeDraftId(): number {
    const draftId = this.#nextDraftId;
    this.#nextDraftId =
      draftId >= MAXIMUM_DRAFT_ID ? DEFAULT_DRAFT_ID : draftId + 1;
    return draftId;
  }

  #scheduleDraft(state: DraftState): void {
    if (
      state.timer ||
      state.sendPending ||
      state.failed ||
      (state.lastSentText === undefined && state.firstEligibleAt === undefined)
    ) {
      return;
    }
    const delayReference =
      state.lastSentText === undefined
        ? (state.firstEligibleAt ?? Date.now())
        : state.lastAttemptAt;
    const delay = Math.max(0, this.#intervalMs - (Date.now() - delayReference));
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (this.#states.get(state.chatId) !== state || state.failed) {
        return;
      }
      this.#queueDraft(state, draftPreview(state.text));
    }, delay);
  }

  #queueDraft(state: DraftState, text: string): void {
    if (text === state.lastSentText || state.failed) {
      return;
    }
    state.sendPending = true;
    this.#enqueue(state.chatId, async () => {
      if (this.#states.get(state.chatId) !== state || state.failed) {
        return;
      }
      state.lastAttemptAt = Date.now();
      const controller = new AbortController();
      state.requestController = controller;
      const timeout = setTimeout(
        () => controller.abort(),
        this.#requestTimeoutMs,
      );
      try {
        await this.#api.sendMessageDraft(
          state.chatId,
          state.draftId,
          text,
          undefined,
          controller.signal,
        );
        if (this.#states.get(state.chatId) === state) {
          state.lastSentText = text;
        }
      } catch (error) {
        if (this.#states.get(state.chatId) === state) {
          state.failed = true;
          this.#logger.info("telegram_draft_failed", {
            chat_id: state.chatId,
            reply_to_message_id: state.replyToMessageId,
            revision: state.generation.revision,
            segment: state.generation.segment,
            error_name: errorName(error),
            reason: "draft_send_failed",
          });
        }
      } finally {
        clearTimeout(timeout);
        if (state.requestController === controller) {
          state.requestController = undefined;
        }
        if (this.#states.get(state.chatId) === state) {
          state.sendPending = false;
          if (
            !state.failed &&
            draftPreview(state.text) !== state.lastSentText
          ) {
            this.#scheduleDraft(state);
          }
        }
      }
    });
  }

  #enqueue(chatId: number, operation: () => Promise<void>): void {
    const previous = this.#operations.get(chatId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.#operations.set(chatId, next);
    void next
      .finally(() => {
        if (this.#operations.get(chatId) === next) {
          this.#operations.delete(chatId);
        }
      })
      .catch(() => undefined);
  }
}

function sameGeneration(
  left: PiTextStreamGeneration,
  right: PiTextStreamGeneration,
): boolean {
  return left.revision === right.revision && left.segment === right.segment;
}

function visibleTextLength(text: string): number {
  return Array.from(text.trim()).length;
}

export function draftPreview(text: string): string {
  if (text.length <= TELEGRAM_DRAFT_LIMIT) {
    return text;
  }
  const marker = "…\n";
  const maximumSuffixLength = TELEGRAM_DRAFT_LIMIT - marker.length;
  let start = text.length - maximumSuffixLength;
  if (isLowSurrogate(text.charCodeAt(start))) {
    start += 1;
  }
  return `${marker}${text.slice(start)}`;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}
