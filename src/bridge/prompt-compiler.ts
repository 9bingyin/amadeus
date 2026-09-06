import { Buffer } from "node:buffer";
import { open, readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { TELEGRAM_PUBLIC_FILE_DOWNLOAD_LIMIT_BYTES } from "../telegram/types";
import type {
  IndexedTelegramMessage,
  NormalizedTelegramMessage,
  ReferencedTelegramMessage,
  TelegramAttachment,
} from "../telegram/types";
import {
  attachmentToFileMetadata,
  formatPiMessage,
  type PiFileMetadata,
} from "./message-format";
import type { PiRpcImage } from "../pi-rpc/types";
import type { ChatState } from "../state";
import {
  markTelegramAttachmentUnavailable,
  TelegramDownloadError,
} from "../telegram/download";
import type { AttachmentDownloader } from "../telegram/types";

export class UnresolvableTelegramReplyError extends Error {
  constructor(messageId: number) {
    super(`无法解析 Telegram reply 目标 ${messageId}`);
    this.name = "UnresolvableTelegramReplyError";
  }
}

export interface CompiledPiPrompt {
  message: string;
  images: PiRpcImage[];
  indexedMessage: IndexedTelegramMessage;
}

export async function compilePiPrompt(
  telegramMessage: NormalizedTelegramMessage,
  sessionId: string,
  chatState: ChatState,
  downloader: AttachmentDownloader,
): Promise<CompiledPiPrompt> {
  const reply = telegramMessage.reply;
  const referenceKnownInSession = isReferenceKnownInSession(
    telegramMessage,
    sessionId,
    chatState,
  );
  const reference = resolveReference(telegramMessage, sessionId, chatState);
  if (
    reply?.messageId !== undefined &&
    !referenceKnownInSession &&
    reference === undefined
  ) {
    throw new UnresolvableTelegramReplyError(reply.messageId);
  }
  const preparedCurrentAttachments = await prepareAttachments(
    telegramMessage.attachments,
    telegramMessage.chatId,
    telegramMessage.messageId,
    downloader,
  );
  const referenceWithPreparedAttachments = reference
    ? {
        ...reference,
        attachments: await prepareAttachments(
          reference.attachments,
          telegramMessage.chatId,
          reference.messageId ?? telegramMessage.messageId,
          downloader,
        ),
      }
    : undefined;
  const currentImages = await readAttachmentImages(preparedCurrentAttachments);
  const referenceImages = referenceWithPreparedAttachments
    ? await readAttachmentImages(referenceWithPreparedAttachments.attachments)
    : undefined;
  const preparedReference =
    referenceWithPreparedAttachments && referenceImages
      ? {
          ...referenceWithPreparedAttachments,
          attachments: referenceImages.attachments,
        }
      : undefined;
  const images = [...currentImages.images, ...(referenceImages?.images ?? [])];
  const files = attachmentsToFiles(currentImages.attachments);
  const resolvedReplyMessageId =
    reply?.messageId !== undefined &&
    (referenceKnownInSession || preparedReference !== undefined)
      ? reply.messageId
      : undefined;
  const hasReplyMetadata =
    resolvedReplyMessageId !== undefined ||
    reply?.story !== undefined ||
    reply?.quote !== undefined ||
    preparedReference !== undefined;

  return {
    message: formatPiMessage(
      {
        messageId: telegramMessage.messageId,
        sentAt: telegramMessage.sentAt,
        sender: formatSender(telegramMessage.sender),
        ...(telegramMessage.forward
          ? { forward: telegramMessage.forward }
          : {}),
        ...(telegramMessage.content
          ? { content: telegramMessage.content }
          : {}),
        ...(telegramMessage.mediaGroupId
          ? { mediaGroupId: telegramMessage.mediaGroupId }
          : {}),
        ...(hasReplyMetadata
          ? {
              reply: {
                ...(resolvedReplyMessageId !== undefined
                  ? { messageId: resolvedReplyMessageId }
                  : {}),
                ...(reply?.story ? { story: reply.story } : {}),
                ...(reply?.quote ? { quote: reply.quote.text } : {}),
                ...(preparedReference ? { reference: preparedReference } : {}),
              },
            }
          : {}),
        ...(files.length > 0 ? { files } : {}),
      },
      telegramMessage.text,
    ),
    images,
    indexedMessage: {
      messageId: telegramMessage.messageId,
      role: "user",
      piSessionId: sessionId,
      sentAt: telegramMessage.sentAt,
      text: telegramMessage.text,
      ...(telegramMessage.forward ? { forward: telegramMessage.forward } : {}),
      ...(telegramMessage.content ? { content: telegramMessage.content } : {}),
      ...(telegramMessage.mediaGroupId
        ? { mediaGroupId: telegramMessage.mediaGroupId }
        : {}),
      attachments: currentImages.attachments,
    },
  };
}

function formatSender(sender: NormalizedTelegramMessage["sender"]): string {
  return sender.username
    ? `@${sender.username}`
    : `${sender.displayName} (${sender.id})`;
}

function isReferenceKnownInSession(
  message: NormalizedTelegramMessage,
  sessionId: string,
  chatState: ChatState,
): boolean {
  const messageId = message.reply?.messageId;
  if (messageId === undefined) {
    return false;
  }
  return chatState.messages[String(messageId)]?.piSessionId === sessionId;
}

function resolveReference(
  message: NormalizedTelegramMessage,
  sessionId: string,
  chatState: ChatState,
): ReferencedTelegramMessage | undefined {
  const reply = message.reply;
  if (!reply) {
    return undefined;
  }

  const indexed =
    reply.messageId === undefined
      ? undefined
      : chatState.messages[String(reply.messageId)];
  if (indexed?.piSessionId === sessionId) {
    if (indexed.role === "user") {
      return undefined;
    }
    if (!indexed.piEntryId) {
      throw new UnresolvableTelegramReplyError(indexed.messageId);
    }
    return {
      messageId: indexed.messageId,
      role: indexed.role,
      sentAt: indexed.sentAt,
      text: "",
      piEntryId: indexed.piEntryId,
      attachments: [],
    };
  }

  if (reply.target && hasReferenceContent(reply.target)) {
    if (
      reply.messageId === undefined ||
      reply.target.messageId !== reply.messageId
    )
      return reply.target;
    const cached = chatState.voiceTranscriptions?.[String(reply.messageId)];
    return {
      ...reply.target,
      attachments: reply.target.attachments.map((attachment) => {
        if (attachment.kind !== "voice") return attachment;
        const saved = indexed?.attachments.find(
          (candidate) =>
            candidate.kind === "voice" &&
            candidate.fileUniqueId === attachment.fileUniqueId,
        );
        const transcription =
          (saved?.kind === "voice" ? saved.transcription : undefined) ??
          (cached?.fileUniqueId === attachment.fileUniqueId
            ? cached.result
            : undefined);
        const { unavailableReason: _reason, ...metadata } = attachment;
        return {
          ...(saved?.localPath && !saved.unavailableReason
            ? { ...metadata, localPath: saved.localPath }
            : attachment),
          ...(transcription ? { transcription } : {}),
        };
      }),
    };
  }
  return indexed;
}

function hasReferenceContent(reference: ReferencedTelegramMessage): boolean {
  return (
    reference.text.length > 0 ||
    reference.content !== undefined ||
    reference.attachments.length > 0 ||
    reference.forward !== undefined
  );
}

async function prepareAttachments(
  source: readonly TelegramAttachment[],
  chatId: number,
  messageId: number,
  downloader: AttachmentDownloader,
): Promise<TelegramAttachment[]> {
  const attachments: TelegramAttachment[] = [];
  for (const attachment of source) {
    if (attachment.unavailableReason) {
      attachments.push(attachment);
      continue;
    }
    try {
      attachments.push(
        await prepareAttachment(attachment, chatId, messageId, downloader),
      );
    } catch (error) {
      attachments.push(markTelegramAttachmentUnavailable(attachment, error));
    }
  }
  return attachments;
}

async function prepareAttachment(
  attachment: TelegramAttachment,
  chatId: number,
  messageId: number,
  downloader: AttachmentDownloader,
): Promise<TelegramAttachment> {
  if (attachment.localPath) {
    try {
      return await validateLocalAttachment({
        ...attachment,
        localPath: attachment.localPath,
      });
    } catch (error) {
      if (
        error instanceof TelegramDownloadError &&
        error.code === "too_large"
      ) {
        throw error;
      }
    }
  }

  const {
    localPath: _localPath,
    unavailableReason: _reason,
    ...metadata
  } = attachment;
  return downloader.download(metadata, chatId, messageId);
}

async function validateLocalAttachment(
  attachment: TelegramAttachment & { localPath: string },
): Promise<TelegramAttachment> {
  if (!isAbsolute(attachment.localPath)) {
    throw new TelegramDownloadError("write", "附件路径不是绝对路径", {
      reason: "write_failed",
    });
  }
  const info = await stat(attachment.localPath);
  if (!info.isFile()) {
    throw new TelegramDownloadError("write", "附件路径不是文件", {
      reason: "write_failed",
    });
  }
  if (info.size > TELEGRAM_PUBLIC_FILE_DOWNLOAD_LIMIT_BYTES) {
    throw new TelegramDownloadError("too_large", "本地附件超过下载限制", {
      reason: "response_too_large",
    });
  }
  const handle = await open(attachment.localPath, "r");
  await handle.close();
  return {
    ...attachment,
    size: info.size,
    mimeType: localAttachmentMimeType(attachment),
  };
}

async function readAttachmentImages(
  source: readonly TelegramAttachment[],
): Promise<{ attachments: TelegramAttachment[]; images: PiRpcImage[] }> {
  const attachments: TelegramAttachment[] = [];
  const images: PiRpcImage[] = [];
  for (const attachment of source) {
    const isImage =
      attachment.kind === "photo" ||
      (attachment.kind === "sticker" && attachment.format === "static");
    if (!isImage || attachment.unavailableReason) {
      attachments.push(attachment);
      continue;
    }
    try {
      if (!attachment.localPath) {
        throw new Error("图片没有本机路径");
      }
      const data = await readFile(attachment.localPath);
      if (data.byteLength > TELEGRAM_PUBLIC_FILE_DOWNLOAD_LIMIT_BYTES) {
        throw new TelegramDownloadError("too_large", "本地图片超过下载限制", {
          reason: "response_too_large",
        });
      }
      const mimeType = detectImageMimeType(data);
      if (!mimeType) {
        attachments.push({
          ...attachment,
          size: data.byteLength,
          mimeType: "application/octet-stream",
        });
        continue;
      }
      images.push({
        type: "image",
        data: Buffer.from(data).toString("base64"),
        mimeType,
      });
      attachments.push({ ...attachment, size: data.byteLength, mimeType });
    } catch (error) {
      attachments.push(markTelegramAttachmentUnavailable(attachment, error));
    }
  }
  return { attachments, images };
}

function localAttachmentMimeType(attachment: TelegramAttachment): string {
  if (isValidMimeType(attachment.mimeType)) {
    return attachment.mimeType;
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

function isValidMimeType(value: string | undefined): value is string {
  return (
    value !== undefined &&
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value)
  );
}

// Identify the container from bytes, never from transport headers or filenames.
// This is MIME detection, not a full image decoder or integrity check.
function detectImageMimeType(data: Buffer): string | undefined {
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  )
    return "image/jpeg";
  if (
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  const header = data.toString("latin1", 0, 6);
  if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  if (
    data.length >= 16 &&
    data.toString("latin1", 0, 4) === "RIFF" &&
    data.toString("latin1", 8, 12) === "WEBP" &&
    ["VP8 ", "VP8L", "VP8X"].includes(data.toString("latin1", 12, 16))
  )
    return "image/webp";
  return undefined;
}

function attachmentsToFiles(
  attachments: readonly TelegramAttachment[],
): PiFileMetadata[] {
  return attachments.map(attachmentToFileMetadata);
}
