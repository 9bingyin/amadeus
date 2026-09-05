import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { errorName, noopInfoLogger, type InfoLogger } from "../logging/logger";
import {
  TELEGRAM_PUBLIC_FILE_DOWNLOAD_LIMIT_BYTES,
  type TelegramAttachment,
  type TelegramAttachmentUnavailableReason,
} from "./types";

export type TelegramDownloadErrorCode =
  "too_large" | "metadata" | "network" | "write";

export type TelegramDownloadFailureReason =
  | "declared_too_large"
  | "get_file_failed"
  | "file_path_missing"
  | "fetch_failed"
  | "http_failed"
  | "response_too_large"
  | "write_failed";

export interface TelegramDownloadErrorOptions extends ErrorOptions {
  reason?: TelegramDownloadFailureReason;
  httpStatus?: number;
}

export class TelegramDownloadError extends Error {
  readonly code: TelegramDownloadErrorCode;
  readonly reason: TelegramDownloadFailureReason;
  readonly httpStatus: number | undefined;

  constructor(
    code: TelegramDownloadErrorCode,
    message: string,
    options: TelegramDownloadErrorOptions = {},
  ) {
    super(message, options);
    this.name = "TelegramDownloadError";
    this.code = code;
    this.reason = options.reason ?? defaultFailureReason(code);
    this.httpStatus = options.httpStatus;
  }
}

export interface TelegramFileApi {
  getFile(
    fileId: string,
    signal?: AbortSignal,
  ): Promise<{ file_path?: string }>;
}

export type TelegramFileFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface TelegramFileDownloaderOptions {
  api: TelegramFileApi;
  botToken: string;
  downloadsDir: string;
  fetch?: TelegramFileFetch;
  logger?: InfoLogger;
  voiceTimeoutMs?: number;
}

export class TelegramFileDownloader {
  readonly #api: TelegramFileApi;
  readonly #botToken: string;
  readonly #downloadsDir: string;
  readonly #fetch: TelegramFileFetch;
  readonly #logger: InfoLogger;
  readonly #voiceTimeoutMs: number;

  constructor(options: TelegramFileDownloaderOptions) {
    this.#api = options.api;
    this.#botToken = options.botToken;
    this.#downloadsDir = options.downloadsDir;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#logger = options.logger ?? noopInfoLogger;
    this.#voiceTimeoutMs = options.voiceTimeoutMs ?? 30_000;
  }

  async download(
    attachment: TelegramAttachment,
    chatId: number,
    messageId: number,
  ): Promise<TelegramAttachment> {
    const startedAt = Date.now();
    this.#logger.info("telegram_file_download_started", {
      attachment_kind: attachment.kind,
      chat_id: chatId,
      message_id: messageId,
      file_unique_id: attachment.fileUniqueId,
      ...(attachment.size !== undefined
        ? { file_size_bytes: attachment.size }
        : {}),
    });

    const controller =
      attachment.kind === "voice" ? new AbortController() : undefined;
    const timer = controller
      ? setTimeout(() => controller.abort(), this.#voiceTimeoutMs)
      : undefined;
    try {
      const result = await this.#download(
        attachment,
        chatId,
        messageId,
        controller?.signal,
      );
      this.#logger.info("telegram_file_download_succeeded", {
        attachment_kind: attachment.kind,
        chat_id: chatId,
        message_id: messageId,
        file_unique_id: attachment.fileUniqueId,
        ...(attachment.size !== undefined
          ? { file_size_bytes: attachment.size }
          : {}),
        cache_hit: result.cacheHit,
        duration_ms: Date.now() - startedAt,
      });
      return result.attachment;
    } catch (error) {
      const failure =
        error instanceof TelegramDownloadError
          ? error
          : new TelegramDownloadError("write", "文件处理失败", {
              reason: "write_failed",
            });
      this.#logger.info("telegram_file_download_failed", {
        attachment_kind: attachment.kind,
        chat_id: chatId,
        message_id: messageId,
        file_unique_id: attachment.fileUniqueId,
        ...(attachment.size !== undefined
          ? { file_size_bytes: attachment.size }
          : {}),
        error_name: errorName(error),
        reason: failure.reason,
        ...(failure.httpStatus !== undefined
          ? { http_status: failure.httpStatus }
          : {}),
      });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async #download(
    attachment: TelegramAttachment,
    chatId: number,
    messageId: number,
    signal?: AbortSignal,
  ): Promise<{ attachment: TelegramAttachment; cacheHit: boolean }> {
    signal?.throwIfAborted();
    if ((attachment.size ?? 0) > TELEGRAM_PUBLIC_FILE_DOWNLOAD_LIMIT_BYTES) {
      throw new TelegramDownloadError(
        "too_large",
        `文件 ${attachmentDisplayName(attachment)} 超过 Telegram Bot API 下载限制`,
        { reason: "declared_too_large" },
      );
    }

    let file: { file_path?: string };
    try {
      file = await this.#api.getFile(attachment.fileId, signal);
      signal?.throwIfAborted();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("file is too big")) {
        throw new TelegramDownloadError(
          "too_large",
          "文件超过 Telegram Bot API 下载限制",
          {
            cause: error,
            reason: "declared_too_large",
          },
        );
      }
      throw new TelegramDownloadError(
        "metadata",
        "无法获取 Telegram 文件信息",
        {
          cause: error,
          reason: "get_file_failed",
        },
      );
    }

    if (!file.file_path) {
      throw new TelegramDownloadError("metadata", "Telegram 没有返回文件路径", {
        reason: "file_path_missing",
      });
    }

    const directory = resolve(this.#downloadsDir, String(chatId));
    await mkdir(directory, { recursive: true });
    const targetPath = resolve(
      directory,
      buildFileName(attachment, messageId, file.file_path),
    );

    try {
      const existing = await stat(targetPath);
      if (!existing.isFile()) {
        throw new Error("缓存路径不是文件");
      }
      if (existing.size > TELEGRAM_PUBLIC_FILE_DOWNLOAD_LIMIT_BYTES) {
        throw new TelegramDownloadError(
          "too_large",
          "已缓存文件超过 Telegram Bot API 下载限制",
          { reason: "response_too_large" },
        );
      }
      const handle = await open(targetPath, "r");
      await handle.close();
      signal?.throwIfAborted();
      return {
        attachment: prepareDownloadedAttachment(
          attachment,
          targetPath,
          existing.size,
          file.file_path,
        ),
        cacheHit: true,
      };
    } catch (error) {
      if (error instanceof TelegramDownloadError) {
        throw error;
      }
      // 文件尚未下载。
    }

    const tempPath = `${targetPath}.${process.pid}.part`;
    const url = `https://api.telegram.org/file/bot${this.#botToken}/${file.file_path}`;

    let response: Response;
    try {
      response = await this.#fetch(url, signal ? { signal } : undefined);
    } catch (error) {
      throw new TelegramDownloadError(
        "network",
        "下载 Telegram 文件时网络失败",
        {
          cause: error,
          reason: "fetch_failed",
        },
      );
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new TelegramDownloadError(
        "network",
        `下载 Telegram 文件失败，HTTP ${response.status}`,
        { reason: "http_failed", httpStatus: response.status },
      );
    }

    const declaredResponseSize = responseContentLength(response);
    if (
      declaredResponseSize !== undefined &&
      declaredResponseSize > TELEGRAM_PUBLIC_FILE_DOWNLOAD_LIMIT_BYTES
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new TelegramDownloadError(
        "too_large",
        "Telegram 文件响应超过下载限制",
        { reason: "response_too_large" },
      );
    }

    let actualSize: number;
    try {
      actualSize = await writeResponseWithLimit(tempPath, response, signal);
      signal?.throwIfAborted();
      await rename(tempPath, targetPath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      if (error instanceof TelegramDownloadError) {
        throw error;
      }
      throw new TelegramDownloadError("write", "保存 Telegram 文件失败", {
        cause: error,
        reason: "write_failed",
      });
    }

    return {
      attachment: prepareDownloadedAttachment(
        attachment,
        targetPath,
        actualSize,
        file.file_path,
        response.headers.get("content-type") ?? undefined,
      ),
      cacheHit: false,
    };
  }
}

async function writeResponseWithLimit(
  path: string,
  response: Response,
  signal?: AbortSignal,
): Promise<number> {
  const handle = await open(path, "w");
  let total = 0;
  try {
    if (!response.body) {
      return 0;
    }
    const reader = response.body.getReader();
    let cancellation: Promise<void> | undefined;
    const abort = (): void => {
      cancellation ??= reader.cancel().catch(() => undefined);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      while (true) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        signal?.throwIfAborted();
        if (done) {
          return total;
        }
        const nextTotal = total + value.byteLength;
        if (nextTotal > TELEGRAM_PUBLIC_FILE_DOWNLOAD_LIMIT_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new TelegramDownloadError(
            "too_large",
            "Telegram 文件响应超过下载限制",
            { reason: "response_too_large" },
          );
        }
        await handle.writeFile(value);
        total = nextTotal;
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      await cancellation;
      reader.releaseLock();
    }
  } finally {
    await handle.close();
  }
}

function responseContentLength(response: Response): number | undefined {
  const raw = response.headers.get("content-length");
  if (!raw || !/^\d+$/.test(raw)) {
    return undefined;
  }
  const size = Number(raw);
  return Number.isSafeInteger(size) ? size : undefined;
}

function prepareDownloadedAttachment(
  attachment: TelegramAttachment,
  localPath: string,
  size: number,
  telegramPath: string,
  responseMimeType?: string,
): TelegramAttachment {
  const { unavailableReason: _unavailableReason, ...metadata } = attachment;
  return {
    ...metadata,
    localPath,
    size,
    mimeType:
      normalizeMimeType(attachment.mimeType) ??
      normalizeMimeType(responseMimeType) ??
      inferMimeType(attachment, telegramPath),
  };
}

function normalizeMimeType(value: string | undefined): string | undefined {
  const mimeType = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mimeType && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mimeType)
    ? mimeType
    : undefined;
}

function inferMimeType(
  attachment: TelegramAttachment,
  telegramPath: string,
): string {
  const extension = extname(telegramPath).toLowerCase();
  const knownByExtension: Readonly<Record<string, string>> = {
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".oga": "audio/ogg",
    ".ogg": "audio/ogg",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".tgs": "application/x-tgsticker",
    ".webm": "video/webm",
    ".webp": "image/webp",
  };
  const inferred = knownByExtension[extension];
  if (inferred) {
    return inferred;
  }

  switch (attachment.kind) {
    case "photo":
      return "image/jpeg";
    case "live_photo":
    case "video":
    case "video_note":
      return "video/mp4";
    case "sticker":
      return attachment.format === "animated"
        ? "application/x-tgsticker"
        : attachment.format === "video"
          ? "video/webm"
          : "image/webp";
    case "voice":
      return "audio/ogg";
    case "animation":
    case "audio":
    case "document":
      return "application/octet-stream";
    default: {
      const exhaustive: never = attachment;
      return exhaustive;
    }
  }
}

export function markTelegramAttachmentUnavailable(
  attachment: TelegramAttachment,
  error: unknown,
): TelegramAttachment {
  const { localPath: _localPath, ...metadata } = attachment;
  return {
    ...metadata,
    unavailableReason: telegramDownloadUnavailableReason(error),
  };
}

export function telegramDownloadUnavailableReason(
  error: unknown,
): TelegramAttachmentUnavailableReason {
  return error instanceof TelegramDownloadError && error.code === "too_large"
    ? "telegram_public_api_limit"
    : "download_failed";
}

function defaultFailureReason(
  code: TelegramDownloadErrorCode,
): TelegramDownloadFailureReason {
  switch (code) {
    case "too_large":
      return "declared_too_large";
    case "metadata":
      return "get_file_failed";
    case "network":
      return "fetch_failed";
    case "write":
      return "write_failed";
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

function attachmentDisplayName(attachment: TelegramAttachment): string {
  return attachment.fileName ?? attachment.fileUniqueId;
}

function buildFileName(
  attachment: TelegramAttachment,
  messageId: number,
  telegramPath: string,
): string {
  const uniqueId = sanitizeFileName(attachment.fileUniqueId);
  if (attachment.fileName) {
    const originalName = sanitizeFileName(attachment.fileName);
    return `${messageId}-${uniqueId}-${originalName}`;
  }

  const extension =
    sanitizeExtension(extname(telegramPath)) || defaultExtension(attachment);
  return `${messageId}-${uniqueId}${extension}`;
}

function defaultExtension(attachment: TelegramAttachment): string {
  switch (attachment.kind) {
    case "photo":
      return ".jpg";
    case "live_photo":
    case "video":
    case "video_note":
      return ".mp4";
    case "sticker":
      return attachment.format === "animated"
        ? ".tgs"
        : attachment.format === "video"
          ? ".webm"
          : ".webp";
    case "animation":
    case "audio":
    case "document":
    case "voice":
      return "";
    default: {
      const exhaustive: never = attachment;
      return exhaustive;
    }
  }
}

function sanitizeFileName(value: string): string {
  const sanitized = value
    .replaceAll("/", "_")
    .replaceAll("\\", "_")
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .trim();
  return (sanitized || "file").slice(0, 120);
}

function sanitizeExtension(value: string): string {
  return /^\.[a-zA-Z0-9]{1,10}$/.test(value) ? value.toLowerCase() : "";
}
