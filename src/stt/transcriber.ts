import { OpenRouter } from "@openrouter/sdk";
import { OpenRouterError } from "@openrouter/sdk/models/errors/openroutererror.js";
import { ResponseValidationError } from "@openrouter/sdk/models/errors/responsevalidationerror.js";
import { SDKValidationError } from "@openrouter/sdk/models/errors/sdkvalidationerror.js";
import { HTTPClientError } from "@openrouter/sdk/models/errors/httpclienterrors.js";
import { createHash } from "node:crypto";
import { errorName, noopInfoLogger, type InfoLogger } from "../logging/logger";
import { HTTPClient, type Fetcher } from "@openrouter/sdk/lib/http.js";
import { resolveSttBaseURL, type SttConfig } from "../config";
import { getOrCreateChatState, type StateStore } from "../state";
import type { TelegramAttachment } from "../telegram/types";
import {
  AudioConversionError,
  FfmpegAudioConverter,
  MAX_AUDIO_BYTES,
  type AudioConverter,
} from "./ffmpeg";
import { MAX_TRANSCRIPT_BYTES, type VoiceTranscription } from "./result";

export interface VoiceTranscriber {
  transcribe(
    attachment: Extract<TelegramAttachment, { kind: "voice" }>,
    chatId: number,
    messageId: number,
  ): Promise<VoiceTranscription>;
  close(): Promise<void>;
}

interface TranscriptionContext {
  chatId: number;
  messageId: number;
}

export interface TranscriptionApi {
  transcribe(
    audio: Uint8Array,
    model: string,
    signal: AbortSignal,
    context?: TranscriptionContext,
  ): Promise<string>;
}

export class OpenRouterTranscriptionApi implements TranscriptionApi {
  readonly #client: OpenRouter;
  constructor(
    apiKey: string,
    fetcher?: Fetcher,
    private readonly logger: InfoLogger = noopInfoLogger,
    baseURL?: string,
  ) {
    this.#client = new OpenRouter({
      apiKey,
      serverURL: resolveSttBaseURL(baseURL),
      debugLogger: { group: () => {}, groupEnd: () => {}, log: () => {} },
      httpReferer: "",
      appTitle: "Amadeus",
      appCategories: "",
      retryConfig: { strategy: "none" },
      httpClient: new HTTPClient({
        fetcher: boundedSttFetch(
          fetcher ??
            ((input, init) => fetch(input, { ...init, redirect: "error" })),
        ),
      }),
    });
  }
  async transcribe(
    audio: Uint8Array,
    model: string,
    signal: AbortSignal,
    context?: TranscriptionContext,
  ): Promise<string> {
    const started = Date.now();
    try {
      const result = await this.#client.stt.createTranscription(
        {
          sttRequest: {
            model,
            inputAudio: {
              data: Buffer.from(audio).toString("base64"),
              format: "flac",
            },
          },
        },
        { signal, retries: { strategy: "none" } },
      );
      return result.text;
    } catch (error) {
      const source =
        error instanceof HTTPClientError && error.cause instanceof Error
          ? error.cause
          : error;
      const http = error instanceof OpenRouterError ? error : undefined;
      const requestId =
        http?.headers.get("x-generation-id") ??
        http?.headers.get("x-request-id");
      let upstreamCode: number | undefined;
      if (http && !(error instanceof ResponseValidationError)) {
        try {
          const body: unknown = JSON.parse(http.body);
          if (
            typeof body === "object" &&
            body !== null &&
            "error" in body &&
            typeof body.error === "object" &&
            body.error !== null &&
            "code" in body.error &&
            typeof body.error.code === "number" &&
            Number.isSafeInteger(body.error.code)
          )
            upstreamCode = body.error.code;
        } catch {
          /* Do not log raw response bodies. */
        }
      }
      this.logger.info("stt_request_failed", {
        ...(context
          ? { chat_id: context.chatId, message_id: context.messageId }
          : {}),
        stage: signal.aborted
          ? "cancelled"
          : error instanceof ResponseValidationError
            ? "response_validation"
            : error instanceof SDKValidationError
              ? "request_validation"
              : source instanceof SttResponseLimitError
                ? "response_limit"
                : http
                  ? "http"
                  : "transport",
        error_name:
          error instanceof ResponseValidationError
            ? "ResponseValidationError"
            : error instanceof SDKValidationError
              ? "SDKValidationError"
              : source instanceof SttResponseLimitError
                ? "SttResponseLimitError"
                : http
                  ? "OpenRouterError"
                  : errorName(source),
        ...(http ? { http_status: http.statusCode } : {}),
        ...(upstreamCode !== undefined ? { upstream_code: upstreamCode } : {}),
        ...(requestId
          ? {
              request_fingerprint: `sha256:${createHash("sha256").update(requestId).digest("hex").slice(0, 16)}`,
            }
          : {}),
        duration_ms: Date.now() - started,
      });
      throw error;
    }
  }
}

class SttResponseLimitError extends Error {}

export const MAX_STT_RESPONSE_BYTES = 256 * 1024;

function boundedSttFetch(fetcher: Fetcher): Fetcher {
  return async (input, init) => {
    const response = await fetcher(input, init);
    if (!response.body) return response;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      const declared = Number(response.headers.get("content-length"));
      if (declared > MAX_STT_RESPONSE_BYTES)
        throw new SttResponseLimitError("STT response too large");
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_STT_RESPONSE_BYTES)
          throw new SttResponseLimitError("STT response too large");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    return new Response(Buffer.concat(chunks), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

type EnabledSttConfig = Extract<SttConfig, { enabled: true }>;

export class TelegramVoiceTranscriber implements VoiceTranscriber {
  readonly #tasks = new Set<Promise<VoiceTranscription>>();
  readonly #controllers = new Set<AbortController>();
  readonly #pending = new Map<string, Promise<VoiceTranscription>>();
  #closing = false;

  constructor(
    private readonly config: EnabledSttConfig,
    private readonly stateStore: StateStore,
    private readonly converter: AudioConverter,
    private readonly api: TranscriptionApi,
  ) {}

  static create(
    config: SttConfig,
    stateStore: StateStore,
    attachmentsDir: string,
    logger: InfoLogger = noopInfoLogger,
  ): TelegramVoiceTranscriber | undefined {
    if (!config.enabled) return undefined;
    if (!Bun.which(config.ffmpegCommand))
      throw new Error(
        "STT requires FFmpeg; install it or configure stt.ffmpegCommand",
      );
    return new TelegramVoiceTranscriber(
      config,
      stateStore,
      new FfmpegAudioConverter(config.ffmpegCommand, attachmentsDir),
      new OpenRouterTranscriptionApi(
        config.apiKey,
        undefined,
        logger,
        config.baseURL,
      ),
    );
  }

  transcribe(
    attachment: Extract<TelegramAttachment, { kind: "voice" }>,
    chatId: number,
    messageId: number,
  ): Promise<VoiceTranscription> {
    if (this.#closing)
      return Promise.resolve(this.#failure("service_stopping"));
    const key = JSON.stringify([chatId, messageId, attachment.fileUniqueId]);
    const pending = this.#pending.get(key);
    if (pending) return pending;
    const operation = this.#transcribe(attachment, chatId, messageId);
    this.#pending.set(key, operation);
    void operation
      .finally(() => this.#pending.delete(key))
      .catch(() => undefined);
    return operation;
  }

  async #transcribe(
    attachment: Extract<TelegramAttachment, { kind: "voice" }>,
    chatId: number,
    messageId: number,
  ): Promise<VoiceTranscription> {
    const cached =
      this.stateStore.snapshot().chats[String(chatId)]?.voiceTranscriptions?.[
        String(messageId)
      ];
    if (cached?.fileUniqueId === attachment.fileUniqueId) return cached.result;
    let result: VoiceTranscription;
    if (!attachment.localPath || attachment.unavailableReason)
      result = this.#failure("audio_unavailable");
    else if ((attachment.size ?? 0) > MAX_AUDIO_BYTES)
      result = this.#failure("audio_too_large");
    else if (attachment.duration > this.config.maxDurationSeconds)
      result = this.#failure("audio_too_long");
    else result = await this.#run(attachment.localPath, { chatId, messageId });
    // Save before delivery, without marking the Telegram message as seen.
    // A failed downstream dispatch can then reuse this result on redelivery.
    await this.stateStore.update((state) => {
      const chat = getOrCreateChatState(state, chatId);
      const cache = chat.voiceTranscriptions ?? {};
      cache[String(messageId)] = {
        fileUniqueId: attachment.fileUniqueId,
        result,
      };
      const keys = Object.keys(cache).sort((a, b) => Number(a) - Number(b));
      for (const key of keys.slice(0, Math.max(0, keys.length - 500)))
        delete cache[key];
      chat.voiceTranscriptions = cache;
    });
    return result;
  }

  async #run(
    path: string,
    context: TranscriptionContext,
  ): Promise<VoiceTranscription> {
    const controller = new AbortController();
    this.#controllers.add(controller);
    const task = (async (): Promise<VoiceTranscription> => {
      let converting = true;
      try {
        const audio = await this.converter.convert(
          path,
          this.config.maxDurationSeconds,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        converting = false;
        const text = await this.api.transcribe(
          audio,
          this.config.model,
          controller.signal,
          context,
        );
        controller.signal.throwIfAborted();
        if (!text.trim()) return this.#failure("empty_transcript");
        if (Buffer.byteLength(text) > MAX_TRANSCRIPT_BYTES)
          return this.#failure("response_too_large");
        return {
          provider: "openrouter",
          model: this.config.model,
          status: "completed",
          text,
        };
      } catch (error) {
        return this.#failure(
          controller.signal.aborted
            ? "timeout"
            : error instanceof AudioConversionError
              ? error.code
              : converting
                ? "conversion_failed"
                : "request_failed",
        );
      }
    })();
    this.#tasks.add(task);
    void task
      .finally(() => {
        this.#tasks.delete(task);
        this.#controllers.delete(controller);
      })
      .catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        task,
        new Promise<VoiceTranscription>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve(this.#failure("timeout"));
          }, this.config.timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  #failure(
    code: Extract<VoiceTranscription, { status: "unavailable" }>["code"],
  ): VoiceTranscription {
    return {
      provider: "openrouter",
      model: this.config.model,
      status: "unavailable",
      code,
    };
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const controller of this.#controllers) controller.abort();
    await Promise.allSettled(this.#pending.values());
    await Promise.allSettled(this.#tasks);
  }
}
