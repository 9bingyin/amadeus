import type { AbortSignal } from "abort-controller";
import { autoRetry, type AutoRetryOptions } from "@grammyjs/auto-retry";
import { GrammyError, HttpError, type Transformer } from "grammy";

const MAX_RETRY_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 30_000;

const RETRY_OPTIONS = {
  maxRetryAttempts: MAX_RETRY_ATTEMPTS,
  maxDelaySeconds: MAX_RETRY_DELAY_MS / 1_000,
} as const satisfies Partial<AutoRetryOptions>;

const TRANSIENT_RETRY_METHODS = new Set<string>([
  "deleteMessage",
  "deleteWebhook",
  "getFile",
  "getMe",
  "getMyCommands",
  "sendChatAction",
  "sendMessageDraft",
  "setMyCommands",
]);

type AutoRetryFactory = (options: Partial<AutoRetryOptions>) => Transformer;
type RetryDelay = (delayMs: number, signal?: AbortSignal) => Promise<void>;

class TelegramRetryExhaustedError extends Error {
  constructor() {
    super("Telegram API retry limit reached");
    this.name = "TelegramRetryExhaustedError";
  }
}

export function createTelegramRetryTransformer(
  createRetry: AutoRetryFactory = autoRetry,
  delay: RetryDelay = waitForRetry,
): Transformer {
  const transientRetry = createRetry({
    ...RETRY_OPTIONS,
    rethrowHttpErrors: true,
    rethrowInternalServerErrors: false,
  });
  const rateLimitRetry = createRetry({
    ...RETRY_OPTIONS,
    rethrowHttpErrors: true,
    rethrowInternalServerErrors: true,
  });

  return async (prev, method, payload, signal) => {
    const retry = TRANSIENT_RETRY_METHODS.has(method)
      ? transientRetry
      : rateLimitRetry;
    if (!TRANSIENT_RETRY_METHODS.has(method)) {
      return retry(prev, method, payload, signal);
    }

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await retry(prev, method, payload, signal);
      } catch (error) {
        if (error instanceof HttpError) {
          if (attempt < MAX_RETRY_ATTEMPTS && !signal?.aborted) {
            await delay(retryDelayMs(attempt), signal);
            continue;
          }
          throw new TelegramRetryExhaustedError();
        }
        if (
          error instanceof GrammyError &&
          (error.error_code === 429 || error.error_code >= 500)
        ) {
          throw new TelegramRetryExhaustedError();
        }
        throw error;
      }
    }
  };
}

function retryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Telegram API retry aborted"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("Telegram API retry aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
