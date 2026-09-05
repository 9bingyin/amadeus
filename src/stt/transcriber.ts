import { OpenRouter } from "@openrouter/sdk";
import { HTTPClient, type Fetcher } from "@openrouter/sdk/lib/http.js";
import type { SttConfig } from "../config";
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

export interface TranscriptionApi {
  transcribe(
    audio: Uint8Array,
    model: string,
    signal: AbortSignal,
  ): Promise<string>;
}

export class OpenRouterTranscriptionApi implements TranscriptionApi {
  readonly #client: OpenRouter;
  constructor(apiKey: string, fetcher?: Fetcher) {
    this.#client = new OpenRouter({
      apiKey,
      serverURL: "https://openrouter.ai/api/v1",
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
  ): Promise<string> {
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
  }
}

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
        throw new Error("STT response too large");
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_STT_RESPONSE_BYTES)
          throw new Error("STT response too large");
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
      new OpenRouterTranscriptionApi(config.apiKey),
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
    else result = await this.#run(attachment.localPath);
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

  async #run(path: string): Promise<VoiceTranscription> {
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
