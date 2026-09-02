import { AbortController, type AbortSignal } from "abort-controller";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  realpath,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { constants, type ReadStream } from "node:fs";
import { InputFile } from "grammy";
import type { PiTelegramOutboundRequest } from "../bridge/agent-manager";
import type { TelegramOutboundResult } from "../../plugins/telegram/protocol";
import { getOrCreateChatState, indexMessage, type AppState } from "../state";
import { errorName, noopInfoLogger, type InfoLogger } from "../logging/logger";
import { telegramTimestamp } from "./time";

export const TELEGRAM_DOCUMENT_LIMIT_BYTES = 50 * 1024 * 1024;
export const TELEGRAM_PHOTO_LIMIT_BYTES = 10 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_STATE_TIMEOUT_MS = 5_000;

export interface TelegramOutboundApi {
  sendDocument(
    chatId: number,
    document: InputFile,
    options: TelegramOutboundOptions,
    signal?: AbortSignal,
  ): Promise<TelegramDocumentMessage>;
  sendPhoto(
    chatId: number,
    photo: InputFile,
    options: TelegramOutboundOptions,
    signal?: AbortSignal,
  ): Promise<TelegramPhotoMessage>;
}

export interface TelegramOutboundStateStore {
  update(mutator: (state: AppState) => void): Promise<void>;
}

export interface TelegramOutboundSenderOptions {
  api: TelegramOutboundApi;
  stateStore: TelegramOutboundStateStore;
  rootDir: string;
  storageDir?: string;
  logger?: InfoLogger;
  requestTimeoutMs?: number;
  stateTimeoutMs?: number;
}

interface TelegramOutboundOptions {
  caption?: string;
  reply_parameters: {
    message_id: number;
    allow_sending_without_reply: true;
  };
}

interface TelegramDocumentMessage {
  message_id: number;
  date: number;
  document?: {
    file_id: string;
    file_unique_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
}

interface TelegramPhotoMessage {
  message_id: number;
  date: number;
  photo?: Array<{
    file_id: string;
    file_unique_id: string;
    width: number;
    height: number;
    file_size?: number;
  }>;
}

interface ValidatedFile {
  realPath: string;
  fileName: string;
  size: number;
  mimeType: string;
  handle: FileHandle;
}

interface SnapshotFile {
  path: string;
  size: number;
  handle: FileHandle;
}

export class TelegramOutboundSender {
  readonly #api: TelegramOutboundApi;
  readonly #stateStore: TelegramOutboundStateStore;
  readonly #rootDir: string;
  readonly #storageDir: string;
  readonly #logger: InfoLogger;
  readonly #requestTimeoutMs: number;
  readonly #stateTimeoutMs: number;
  readonly #controllers = new Set<AbortController>();
  readonly #operations = new Set<Promise<TelegramOutboundResult>>();
  #closing = false;

  constructor(options: TelegramOutboundSenderOptions) {
    this.#api = options.api;
    this.#stateStore = options.stateStore;
    this.#rootDir = options.rootDir;
    this.#storageDir =
      options.storageDir ?? join(options.rootDir, ".amadeus-outbound");
    this.#logger = options.logger ?? noopInfoLogger;
    this.#requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#stateTimeoutMs = options.stateTimeoutMs ?? DEFAULT_STATE_TIMEOUT_MS;
  }

  send(request: PiTelegramOutboundRequest): Promise<TelegramOutboundResult> {
    if (this.#closing) {
      return Promise.resolve(
        rejectedResult(
          "service_stopping",
          "Telegram delivery is unavailable while the service is stopping",
        ),
      );
    }
    const operation = this.#send(request);
    this.#operations.add(operation);
    void operation
      .finally(() => this.#operations.delete(operation))
      .catch(() => undefined);
    return operation;
  }

  async close(): Promise<void> {
    this.#closing = true;
    await Promise.allSettled(this.#operations);
  }

  async #send(
    request: PiTelegramOutboundRequest,
  ): Promise<TelegramOutboundResult> {
    const startedAt = Date.now();
    const validated = await this.#validate(request).catch((error: unknown) => {
      const result = rejectedResult(
        validationCode(error),
        validationMessage(error),
      );
      this.#logger.info("telegram_outbound_rejected", {
        chat_id: request.chatId,
        reply_to_message_id: request.replyToMessageId,
        attachment_kind: request.kind,
        error_name: errorName(error),
        reason: result.code,
      });
      return result;
    });
    if (!("realPath" in validated)) {
      return validated;
    }
    if (this.#closing || request.signal.aborted || !request.isCurrent()) {
      await validated.handle.close().catch(() => undefined);
      const result = rejectedResult(
        "stale_revision",
        "The Telegram request belongs to an obsolete response",
      );
      this.#logger.info("telegram_outbound_rejected", {
        chat_id: request.chatId,
        reply_to_message_id: request.replyToMessageId,
        attachment_kind: request.kind,
        error_name: "StaleRevisionError",
        reason: result.code,
      });
      return result;
    }

    this.#logger.info("telegram_outbound_started", {
      chat_id: request.chatId,
      reply_to_message_id: request.replyToMessageId,
      attachment_kind: request.kind,
      file_size_bytes: validated.size,
    });

    const controller = new AbortController();
    this.#controllers.add(controller);
    const abortForRevision = () => controller.abort();
    request.signal.addEventListener("abort", abortForRevision);
    let stream: ReadStream | undefined;
    let message: TelegramDocumentMessage | TelegramPhotoMessage;
    try {
      stream = validated.handle.createReadStream({ autoClose: false });
      const input = new InputFile(stream, validated.fileName);
      const options: TelegramOutboundOptions = {
        ...(request.args.caption !== undefined
          ? { caption: request.args.caption }
          : {}),
        reply_parameters: {
          message_id: request.replyToMessageId,
          allow_sending_without_reply: true,
        },
      };
      const operation =
        request.kind === "document"
          ? this.#api.sendDocument(
              request.chatId,
              input,
              options,
              controller.signal,
            )
          : this.#api.sendPhoto(
              request.chatId,
              input,
              options,
              controller.signal,
            );
      const outcome = await settleWithin(
        operation,
        this.#requestTimeoutMs,
        () => controller.abort(),
      );
      if (outcome.status === "timeout") {
        const result = unknownResult(
          "telegram_delivery_timeout",
          "The Telegram delivery outcome cannot be confirmed after timeout",
        );
        this.#logSendFailure(request, result, "TimeoutError");
        return result;
      }
      if (outcome.status === "rejected") {
        const result = classifyTelegramSendError(outcome.reason);
        this.#logSendFailure(request, result, errorName(outcome.reason));
        return result;
      }
      message = outcome.value;
    } catch (error) {
      const result = classifyTelegramSendError(error);
      this.#logSendFailure(request, result, errorName(error));
      return result;
    } finally {
      request.signal.removeEventListener("abort", abortForRevision);
      this.#controllers.delete(controller);
      stream?.destroy();
      await validated.handle.close().catch(() => undefined);
    }

    const result = await this.#indexSentMessage(request, validated, message);
    if (result.status === "sent") {
      this.#logger.info("telegram_outbound_sent", {
        chat_id: request.chatId,
        reply_to_message_id: request.replyToMessageId,
        telegram_message_id: message.message_id,
        attachment_kind: request.kind,
        file_size_bytes: validated.size,
        indexed: true,
        duration_ms: Date.now() - startedAt,
      });
    } else {
      this.#logSendFailure(request, result, "StatePersistenceError");
    }
    return result;
  }

  #logSendFailure(
    request: PiTelegramOutboundRequest,
    result: Exclude<TelegramOutboundResult, { status: "sent" }>,
    failureName: string,
  ): void {
    this.#logger.info(
      result.status === "rejected"
        ? "telegram_outbound_rejected"
        : "telegram_outbound_unknown",
      {
        chat_id: request.chatId,
        reply_to_message_id: request.replyToMessageId,
        attachment_kind: request.kind,
        error_name: failureName,
        reason: result.code,
      },
    );
  }

  async #validate(request: PiTelegramOutboundRequest): Promise<ValidatedFile> {
    if (
      request.args.caption !== undefined &&
      request.args.caption.length > 1024
    ) {
      throw new OutboundValidationError("caption_too_long");
    }
    if (looksLikeUrl(request.args.path)) {
      throw new OutboundValidationError("url_not_allowed");
    }

    const root = await realpath(this.#rootDir).catch((error: unknown) => {
      throw new OutboundValidationError("root_unavailable", error);
    });
    const candidate = isAbsolute(request.args.path)
      ? request.args.path
      : resolve(root, request.args.path);
    const resolvedPath = await realpath(candidate).catch((error: unknown) => {
      throw new OutboundValidationError("file_not_found", error);
    });
    assertPathInsideRoot(root, resolvedPath);

    const handle = await open(
      resolvedPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    ).catch((error: unknown) => {
      throw new OutboundValidationError("file_unreadable", error);
    });
    let snapshot: SnapshotFile | undefined;
    try {
      const openedPath = await realpath(`/proc/self/fd/${handle.fd}`).catch(
        (error: unknown) => {
          throw new OutboundValidationError("file_identity_unavailable", error);
        },
      );
      assertPathInsideRoot(root, openedPath);

      const metadata = await handle.stat().catch((error: unknown) => {
        throw new OutboundValidationError("file_unavailable", error);
      });
      if (!metadata.isFile()) {
        throw new OutboundValidationError("not_regular_file");
      }

      const limit =
        request.kind === "document"
          ? TELEGRAM_DOCUMENT_LIMIT_BYTES
          : TELEGRAM_PHOTO_LIMIT_BYTES;
      const tooLargeCode =
        request.kind === "document" ? "document_too_large" : "photo_too_large";
      if (metadata.size > limit) {
        throw new OutboundValidationError(tooLargeCode);
      }

      const fileName = basename(openedPath);
      snapshot = await createSnapshot(
        handle,
        join(this.#storageDir, String(request.chatId)),
        limit,
        tooLargeCode,
      );
      const mimeType =
        request.kind === "photo"
          ? await detectPhotoMimeType(snapshot.handle)
          : Bun.file(fileName).type || "application/octet-stream";
      return {
        realPath: snapshot.path,
        fileName,
        size: snapshot.size,
        mimeType,
        handle: snapshot.handle,
      };
    } catch (error) {
      if (snapshot) {
        await snapshot.handle.close().catch(() => undefined);
        await rm(snapshot.path, { force: true }).catch(() => undefined);
      }
      throw error;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async #indexSentMessage(
    request: PiTelegramOutboundRequest,
    file: ValidatedFile,
    message: TelegramDocumentMessage | TelegramPhotoMessage,
  ): Promise<TelegramOutboundResult> {
    const attachment = buildAttachment(request.kind, file, message);
    if (!attachment) {
      return unknownSentResult(
        message.message_id,
        "telegram_response_invalid",
        "Telegram sent the file but returned incomplete media metadata",
      );
    }

    const operation = this.#stateStore.update((state) => {
      indexMessage(getOrCreateChatState(state, request.chatId), {
        messageId: message.message_id,
        role: "assistant",
        piSessionId: request.sessionId,
        piEntryId: request.piEntryId,
        sentAt: telegramTimestamp(message.date),
        text: request.args.caption ?? "",
        content: { kind: request.kind },
        attachments: [attachment],
      });
    });
    const outcome = await settleWithin(operation, this.#stateTimeoutMs);
    if (outcome.status !== "fulfilled") {
      const timedOut = outcome.status === "timeout";
      this.#logger.info("telegram_outbound_index_failed", {
        chat_id: request.chatId,
        telegram_message_id: message.message_id,
        attachment_kind: request.kind,
        error_name: timedOut ? "TimeoutError" : errorName(outcome.reason),
        reason: timedOut ? "state_persist_timeout" : "state_persist_failed",
      });
      return unknownSentResult(
        message.message_id,
        timedOut ? "state_persist_timeout" : "state_persist_failed",
        timedOut
          ? "Telegram sent the file but local indexing did not finish in time"
          : "Telegram sent the file but local indexing failed",
      );
    }

    return {
      version: 1,
      status: "sent",
      kind: request.kind,
      messageId: message.message_id,
      indexed: true,
      fileName: file.fileName,
      size: file.size,
      mimeType: file.mimeType,
    };
  }
}

function buildAttachment(
  kind: "document" | "photo",
  file: ValidatedFile,
  message: TelegramDocumentMessage | TelegramPhotoMessage,
) {
  if (kind === "document") {
    const document = "document" in message ? message.document : undefined;
    if (!document) {
      return undefined;
    }
    return {
      kind,
      fileId: document.file_id,
      fileUniqueId: document.file_unique_id,
      fileName: document.file_name ?? file.fileName,
      mimeType: document.mime_type ?? file.mimeType,
      size: document.file_size ?? file.size,
      localPath: file.realPath,
    } as const;
  }

  const photo = ("photo" in message ? message.photo : undefined)?.at(-1);
  if (!photo) {
    return undefined;
  }
  return {
    kind,
    fileId: photo.file_id,
    fileUniqueId: photo.file_unique_id,
    mimeType: file.mimeType,
    size: photo.file_size ?? file.size,
    width: photo.width,
    height: photo.height,
    localPath: file.realPath,
  } as const;
}

async function createSnapshot(
  source: FileHandle,
  directory: string,
  limit: number,
  tooLargeCode: string,
): Promise<SnapshotFile> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const temporaryPath = join(directory, `.${id}.tmp`);
  const finalPath = join(directory, `${id}.bin`);
  const target = await open(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  let size = 0;
  try {
    const buffer = new Uint8Array(64 * 1024);
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, size);
      if (bytesRead === 0) {
        break;
      }
      if (size + bytesRead > limit) {
        throw new OutboundValidationError(tooLargeCode);
      }
      await writeAll(target, buffer, bytesRead, size);
      size += bytesRead;
    }
    await target.sync();
  } catch (error) {
    await target.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await target.close();
  await rename(temporaryPath, finalPath);

  try {
    const handle = await open(
      finalPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    return { path: finalPath, size, handle };
  } catch (error) {
    await rm(finalPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeAll(
  target: FileHandle,
  buffer: Uint8Array,
  length: number,
  position: number,
): Promise<void> {
  let written = 0;
  while (written < length) {
    const result = await target.write(
      buffer,
      written,
      length - written,
      position + written,
    );
    if (result.bytesWritten === 0) {
      throw new Error("Snapshot write made no progress");
    }
    written += result.bytesWritten;
  }
}

async function detectPhotoMimeType(handle: FileHandle): Promise<string> {
  const bytes = new Uint8Array(16);
  const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
  const header = bytes.subarray(0, bytesRead);
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    header.length >= 8 &&
    header[0] === 0x89 &&
    header[1] === 0x50 &&
    header[2] === 0x4e &&
    header[3] === 0x47 &&
    header[4] === 0x0d &&
    header[5] === 0x0a &&
    header[6] === 0x1a &&
    header[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    header.length >= 12 &&
    ascii(header, 0, 4) === "RIFF" &&
    ascii(header, 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  throw new OutboundValidationError("unsupported_photo_format");
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:\/\//iu.test(value);
}

function assertPathInsideRoot(root: string, path: string): void {
  const relativePath = relative(root, path);
  if (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    isAbsolute(relativePath)
  ) {
    throw new OutboundValidationError("path_outside_root");
  }
}

class OutboundValidationError extends Error {
  readonly code: string;

  constructor(code: string, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "OutboundValidationError";
    this.code = code;
  }
}

function validationCode(error: unknown): string {
  return error instanceof OutboundValidationError
    ? error.code
    : "file_validation_failed";
}

function validationMessage(error: unknown): string {
  const code = validationCode(error);
  const messages: Record<string, string> = {
    caption_too_long: "The caption exceeds 1024 UTF-16 units",
    url_not_allowed: "URLs are not allowed; provide a local file path",
    root_unavailable: "The configured working directory is unavailable",
    file_not_found: "The local file does not exist",
    path_outside_root:
      "The local file is outside the configured working directory",
    file_unavailable: "The local file is unavailable",
    not_regular_file: "The local path is not a regular file",
    file_unreadable: "The local file is not readable",
    file_identity_unavailable:
      "The opened local file identity cannot be verified",
    document_too_large: "The document exceeds the 50 MiB Telegram limit",
    photo_too_large: "The photo exceeds the 10 MiB Telegram limit",
    unsupported_photo_format: "The photo must be a JPEG, PNG, or WebP image",
  };
  return messages[code] ?? "The local file failed validation";
}

type BoundedOutcome<Value> =
  | { status: "fulfilled"; value: Value }
  | { status: "rejected"; reason: unknown }
  | { status: "timeout" };

function settleWithin<Value>(
  operation: Promise<Value>,
  timeoutMs: number,
  onTimeout: () => void = () => undefined,
): Promise<BoundedOutcome<Value>> {
  return new Promise((resolveOutcome) => {
    let settled = false;
    const finish = (outcome: BoundedOutcome<Value>): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolveOutcome(outcome);
    };
    const timeout = setTimeout(() => {
      try {
        onTimeout();
      } finally {
        finish({ status: "timeout" });
      }
    }, timeoutMs);
    void operation
      .then(
        (value) => finish({ status: "fulfilled", value }),
        (reason: unknown) => finish({ status: "rejected", reason }),
      )
      .catch(() => undefined);
  });
}

function unknownResult(
  code: string,
  message: string,
): Extract<TelegramOutboundResult, { status: "unknown" }> {
  return { version: 1, status: "unknown", code, message };
}

function unknownSentResult(
  messageId: number,
  code: string,
  message: string,
): Extract<TelegramOutboundResult, { status: "unknown" }> {
  return {
    ...unknownResult(code, message),
    telegramSent: true,
    messageId,
  };
}

function rejectedResult(
  code: string,
  message: string,
): Extract<TelegramOutboundResult, { status: "rejected" }> {
  return { version: 1, status: "rejected", code, message };
}

function classifyTelegramSendError(
  error: unknown,
): Exclude<TelegramOutboundResult, { status: "sent" }> {
  const code = telegramErrorCode(error);
  if (code !== undefined && code >= 400 && code < 500 && code !== 408) {
    if (code === 429) {
      return rejectedResult(
        "telegram_rate_limited",
        "Telegram rate-limited the request",
      );
    }
    return rejectedResult(
      "telegram_rejected",
      "Telegram rejected the file delivery request",
    );
  }
  return {
    version: 1,
    status: "unknown",
    code: "telegram_delivery_unknown",
    message: "The Telegram delivery outcome cannot be confirmed",
  };
}

function telegramErrorCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const value = Reflect.get(error, "error_code");
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}
