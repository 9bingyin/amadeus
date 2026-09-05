import {
  TELEGRAM_PUBLIC_FILE_DOWNLOAD_LIMIT_BYTES,
  type ReferencedTelegramMessage,
  type TelegramAttachment,
  type TelegramAttachmentUnavailableReason,
  type TelegramForwardOrigin,
  type TelegramMessageContent,
} from "../telegram/types";

import type { VoiceTranscription } from "../stt/result";

interface PiFileBaseMetadata {
  transcription?: VoiceTranscription;
  kind: TelegramAttachment["kind"];
  name: string;
  mimeType?: string;
  size?: number;
  source?: TelegramAttachment["source"];
  sourceSection?: TelegramAttachment["sourceSection"];
  sourceIndex?: number;
  width?: number;
  height?: number;
  duration?: number;
  length?: number;
  performer?: string;
  title?: string;
  stickerType?: string;
  format?: string;
  emoji?: string;
  setName?: string;
  startTimestamp?: number;
}

export type PiFileMetadata = PiFileBaseMetadata &
  (
    | { status: "available"; path: string }
    | {
        status: "unavailable";
        reason: TelegramAttachmentUnavailableReason;
        limitBytes?: number;
      }
  );

export interface PiReplyMetadata {
  messageId?: number;
  story?: { chatId: number; storyId: number };
  quote?: string;
  reference?: ReferencedTelegramMessage;
}

export interface PiMessageMetadata {
  messageId: number;
  sentAt: string;
  sender?: string;
  forward?: TelegramForwardOrigin;
  reply?: PiReplyMetadata;
  content?: TelegramMessageContent;
  mediaGroupId?: string;
  files?: PiFileMetadata[];
}

export function formatPiMessage(
  metadata: PiMessageMetadata,
  body: string,
): string {
  const attributes = [
    attribute("id", String(metadata.messageId)),
    attribute("t", metadata.sentAt),
    optionalAttribute("by", metadata.sender),
    optionalAttribute(
      "fwd",
      metadata.forward ? formatForwardSource(metadata.forward) : undefined,
    ),
    optionalAttribute("orig", metadata.forward?.sentAt),
    optionalAttribute("reply", metadata.reply?.messageId?.toString()),
    optionalAttribute(
      "reply_story_chat",
      metadata.reply?.story?.chatId.toString(),
    ),
    optionalAttribute("reply_story", metadata.reply?.story?.storyId.toString()),
    optionalAttribute("group", metadata.mediaGroupId),
  ].filter((item): item is string => item !== undefined);

  const children: string[] = [];
  if (metadata.content) {
    children.push(formatContent(metadata.content));
  }
  if (metadata.reply?.reference) {
    children.push(formatReference(metadata.reply.reference));
  }
  if (metadata.reply?.quote) {
    children.push(`<q>${escapeXmlText(metadata.reply.quote)}</q>`);
  }
  for (const file of metadata.files ?? []) {
    children.push(formatFile(file));
  }

  const tag =
    children.length === 0
      ? `<tg ${attributes.join(" ")}/>`
      : `<tg ${attributes.join(" ")}>${children.join("")}</tg>`;

  return body.length === 0 ? tag : `${tag}\n${body}`;
}

export function formatForwardSource(origin: TelegramForwardOrigin): string {
  switch (origin.kind) {
    case "user": {
      const identity = origin.username
        ? `@${origin.username}`
        : origin.displayName;
      return `${origin.isBot ? "bot" : "user"}:${identity}`;
    }
    case "hidden_user":
      return `hidden:${origin.displayName}`;
    case "chat":
      return `chat:${origin.username ? `@${origin.username}` : origin.title}`;
    case "channel": {
      const identity = origin.username ? `@${origin.username}` : origin.title;
      return `channel:${identity}/${origin.messageId}`;
    }
    default: {
      const exhaustive: never = origin;
      throw new Error(`未知转发来源：${String(exhaustive)}`);
    }
  }
}

function formatReference(reference: ReferencedTelegramMessage): string {
  const attributes = [
    attribute("role", reference.role),
    optionalAttribute("id", reference.messageId?.toString()),
    optionalAttribute("entry", reference.piEntryId),
    optionalAttribute(
      "fwd",
      reference.forward ? formatForwardSource(reference.forward) : undefined,
    ),
    optionalAttribute("orig", reference.forward?.sentAt),
    optionalAttribute("group", reference.mediaGroupId),
    optionalAttribute(
      "media",
      reference.attachments.length > 0 ? mediaSummary(reference) : undefined,
    ),
  ].filter((item): item is string => item !== undefined);

  const files = reference.attachments.map((attachment) =>
    formatFile(attachmentToFileMetadata(attachment)),
  );
  if (!reference.content && files.length === 0) {
    return reference.text.length === 0
      ? `<ref ${attributes.join(" ")}/>`
      : `<ref ${attributes.join(" ")}>${escapeXmlText(reference.text)}</ref>`;
  }

  const children = [
    reference.content ? formatContent(reference.content) : "",
    reference.text.length > 0
      ? `<text>${escapeXmlText(reference.text)}</text>`
      : "",
    ...files,
  ].join("");
  return `<ref ${attributes.join(" ")}>${children}</ref>`;
}

function mediaSummary(reference: ReferencedTelegramMessage): string {
  const kinds = new Set(
    reference.attachments.map((attachment) => attachment.kind),
  );
  return [...kinds].sort().join(",");
}

function formatContent(content: TelegramMessageContent): string {
  switch (content.kind) {
    case "unavailable":
      return `<content ${[
        attribute("kind", content.contentKind),
        attribute("status", "unavailable"),
        attribute("reason", content.reasons.join(",")),
      ].join(" ")}/>`;
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
      return `<content ${attribute("kind", content.kind)}/>`;
    case "rich_message": {
      const attributes = [
        attribute("kind", content.kind),
        attribute("blocks", content.blockTypes.join(",")),
        optionalAttribute(
          "unavailable",
          content.unavailableBlockCount?.toString(),
        ),
        optionalAttribute("reason", content.unavailableReasons?.join(",")),
      ].filter((item): item is string => item !== undefined);
      return `<content ${attributes.join(" ")}/>`;
    }
    case "paid_media": {
      const attributes = [
        attribute("kind", content.kind),
        attribute("stars", String(content.starCount)),
        attribute("items", String(content.itemCount)),
        attribute("unavailable", String(content.unavailableItemCount)),
        ...(content.unavailableReasons && content.unavailableReasons.length > 0
          ? [attribute("reason", content.unavailableReasons.join(","))]
          : content.unavailableItemCount > 0
            ? [attribute("reason", "content_unavailable")]
            : []),
      ];
      const previews = (content.previews ?? [])
        .map((preview) => {
          const previewAttributes = [
            attribute("index", String(preview.index)),
            attribute("status", "unavailable"),
            attribute("reason", "content_unavailable"),
            optionalAttribute("width", preview.width?.toString()),
            optionalAttribute("height", preview.height?.toString()),
            optionalAttribute("duration", preview.duration?.toString()),
          ].filter((item): item is string => item !== undefined);
          return `<preview ${previewAttributes.join(" ")}/>`;
        })
        .join("");
      return previews.length > 0
        ? `<content ${attributes.join(" ")}>${previews}</content>`
        : `<content ${attributes.join(" ")}/>`;
    }
    case "story":
      return `<content ${[
        attribute("kind", content.kind),
        attribute("chat", String(content.chatId)),
        attribute("story", String(content.storyId)),
        attribute("status", "unavailable"),
        attribute("reason", "content_unavailable"),
      ].join(" ")}/>`;
    case "contact": {
      const attributes = [
        attribute("kind", content.kind),
        attribute("phone", content.phoneNumber),
        attribute("first", content.firstName),
        optionalAttribute("last", content.lastName),
        optionalAttribute("user", content.userId?.toString()),
      ].filter((item): item is string => item !== undefined);
      return content.vcard
        ? `<content ${attributes.join(" ")}><vcard>${escapeXmlText(content.vcard)}</vcard></content>`
        : `<content ${attributes.join(" ")}/>`;
    }
    case "dice":
      return `<content ${[
        attribute("kind", content.kind),
        attribute("emoji", content.emoji),
        attribute("value", String(content.value)),
      ].join(" ")}/>`;
    case "game":
      return `<content ${[
        attribute("kind", content.kind),
        attribute("title", content.title),
        attribute("description", content.description),
      ].join(" ")}><text>${escapeXmlText(content.text)}</text></content>`;
    case "poll":
      return formatPollContent(content);
    case "venue": {
      const attributes = [
        attribute("kind", content.kind),
        attribute("latitude", String(content.latitude)),
        attribute("longitude", String(content.longitude)),
        attribute("title", content.title),
        attribute("address", content.address),
        optionalAttribute("foursquare", content.foursquareId),
        optionalAttribute("foursquare_type", content.foursquareType),
        optionalAttribute("google_place", content.googlePlaceId),
        optionalAttribute("google_place_type", content.googlePlaceType),
      ].filter((item): item is string => item !== undefined);
      return `<content ${attributes.join(" ")}/>`;
    }
    case "location": {
      const attributes = [
        attribute("kind", content.kind),
        attribute("latitude", String(content.latitude)),
        attribute("longitude", String(content.longitude)),
        optionalAttribute("accuracy", content.horizontalAccuracy?.toString()),
        optionalAttribute("live_period", content.livePeriod?.toString()),
        optionalAttribute("heading", content.heading?.toString()),
        optionalAttribute(
          "proximity_radius",
          content.proximityAlertRadius?.toString(),
        ),
      ].filter((item): item is string => item !== undefined);
      return `<content ${attributes.join(" ")}/>`;
    }
    case "checklist": {
      const tasks = content.tasks
        .map((task) => {
          const attributes = [
            attribute("id", String(task.id)),
            attribute("completed", String(task.completed)),
            optionalAttribute(
              "completion_date",
              task.completionDate?.toString(),
            ),
            optionalAttribute(
              "completed_by_user",
              task.completedByUserId?.toString(),
            ),
            optionalAttribute(
              "completed_by_chat",
              task.completedByChatId?.toString(),
            ),
          ].filter((item): item is string => item !== undefined);
          return `<task ${attributes.join(" ")}>${escapeXmlText(task.text)}</task>`;
        })
        .join("");
      return `<content ${[
        attribute("kind", content.kind),
        attribute("title", content.title),
        attribute("others_add", String(content.othersCanAddTasks)),
        attribute("others_done", String(content.othersCanMarkTasksDone)),
      ].join(" ")}>${tasks}</content>`;
    }
    default: {
      const exhaustive: never = content;
      throw new Error(`未知 Telegram 内容类型：${String(exhaustive)}`);
    }
  }
}

function formatPollContent(
  content: Extract<TelegramMessageContent, { kind: "poll" }>,
): string {
  const attributes = [
    attribute("kind", content.kind),
    attribute("question", content.question),
    attribute("voters", String(content.totalVoterCount)),
    attribute("closed", String(content.closed)),
    attribute("anonymous", String(content.anonymous)),
    attribute("type", content.pollType),
    attribute("multiple", String(content.multipleAnswers)),
    attribute("revoting", String(content.allowsRevoting)),
    attribute("members_only", String(content.membersOnly)),
    optionalAttribute("correct", content.correctOptionIds?.join(",")),
    optionalAttribute("countries", content.countryCodes?.join(",")),
    optionalAttribute("open_period", content.openPeriod?.toString()),
    optionalAttribute("close_date", content.closeDate?.toString()),
  ].filter((item): item is string => item !== undefined);
  const options = content.options
    .map(
      (option, index) =>
        `<option ${attribute("index", String(index))} ${attribute("voters", String(option.voterCount))}>${escapeXmlText(option.text)}</option>`,
    )
    .join("");
  const explanation = content.explanation
    ? `<explanation>${escapeXmlText(content.explanation)}</explanation>`
    : "";
  const description = content.description
    ? `<description>${escapeXmlText(content.description)}</description>`
    : "";
  const media = (content.media ?? []).map(formatPollEmbeddedContent).join("");
  return `<content ${attributes.join(" ")}>${options}${description}${explanation}${media}</content>`;
}

function formatPollEmbeddedContent(
  media: NonNullable<
    Extract<TelegramMessageContent, { kind: "poll" }>["media"]
  >[number],
): string {
  const position = [
    attribute("section", media.section),
    optionalAttribute(
      "option",
      media.section === "option" ? media.optionIndex.toString() : undefined,
    ),
  ].filter((item): item is string => item !== undefined);

  switch (media.kind) {
    case "link":
      return `<poll_media ${[
        ...position,
        attribute("kind", media.kind),
        attribute("url", media.url),
      ].join(" ")}/>`;
    case "location":
      return `<poll_media ${[
        ...position,
        attribute("kind", media.kind),
        attribute("latitude", String(media.latitude)),
        attribute("longitude", String(media.longitude)),
        ...(media.horizontalAccuracy !== undefined
          ? [attribute("accuracy", String(media.horizontalAccuracy))]
          : []),
      ].join(" ")}/>`;
    case "venue":
      return `<poll_media ${[
        ...position,
        attribute("kind", media.kind),
        attribute("latitude", String(media.latitude)),
        attribute("longitude", String(media.longitude)),
        attribute("title", media.title),
        attribute("address", media.address),
      ].join(" ")}/>`;
    default: {
      const exhaustive: never = media;
      throw new Error(`未知 Telegram poll media：${String(exhaustive)}`);
    }
  }
}

export function attachmentToFileMetadata(
  attachment: TelegramAttachment,
): PiFileMetadata {
  const base = {
    kind: attachment.kind,
    ...(attachment.kind === "voice" && attachment.transcription
      ? { transcription: attachment.transcription }
      : {}),
    name:
      attachment.fileName ??
      (attachment.kind === "photo"
        ? `${attachment.fileUniqueId}.jpg`
        : attachment.fileUniqueId),
    ...(attachment.mimeType
      ? { mimeType: attachment.mimeType }
      : attachment.kind === "photo"
        ? { mimeType: "image/jpeg" }
        : attachment.kind === "sticker"
          ? { mimeType: stickerMimeType(attachment.format) }
          : {}),
    ...(attachment.size !== undefined ? { size: attachment.size } : {}),
    ...(attachment.source ? { source: attachment.source } : {}),
    ...(attachment.sourceSection
      ? { sourceSection: attachment.sourceSection }
      : {}),
    ...(attachment.sourceIndex !== undefined
      ? { sourceIndex: attachment.sourceIndex }
      : {}),
    ...(hasDimensions(attachment)
      ? { width: attachment.width, height: attachment.height }
      : {}),
    ...(hasDuration(attachment) ? { duration: attachment.duration } : {}),
    ...(attachment.kind === "video_note" ? { length: attachment.length } : {}),
    ...(attachment.kind === "audio" && attachment.performer
      ? { performer: attachment.performer }
      : {}),
    ...(attachment.kind === "audio" && attachment.title
      ? { title: attachment.title }
      : {}),
    ...(attachment.kind === "sticker"
      ? {
          stickerType: attachment.stickerType,
          format: attachment.format,
          ...(attachment.emoji ? { emoji: attachment.emoji } : {}),
          ...(attachment.setName ? { setName: attachment.setName } : {}),
        }
      : {}),
    ...(attachment.kind === "video" && attachment.startTimestamp !== undefined
      ? { startTimestamp: attachment.startTimestamp }
      : {}),
  };

  if (attachment.localPath && !attachment.unavailableReason) {
    return {
      ...base,
      status: "available",
      path: attachment.localPath,
    };
  }
  if (attachment.unavailableReason && !attachment.localPath) {
    return {
      ...base,
      status: "unavailable",
      reason: attachment.unavailableReason,
      ...(attachment.unavailableReason === "telegram_public_api_limit"
        ? { limitBytes: TELEGRAM_PUBLIC_FILE_DOWNLOAD_LIMIT_BYTES }
        : {}),
    };
  }
  throw new Error(`Telegram ${attachment.kind} 附件尚未准备完成`);
}

function hasDimensions(
  attachment: TelegramAttachment,
): attachment is TelegramAttachment & { width: number; height: number } {
  return "width" in attachment && "height" in attachment;
}

function hasDuration(
  attachment: TelegramAttachment,
): attachment is TelegramAttachment & { duration: number } {
  return "duration" in attachment;
}

function stickerMimeType(
  format: Extract<TelegramAttachment, { kind: "sticker" }>["format"],
): string {
  switch (format) {
    case "static":
      return "image/webp";
    case "animated":
      return "application/x-tgsticker";
    case "video":
      return "video/webm";
    default: {
      const exhaustive: never = format;
      throw new Error(`未知 sticker 格式：${String(exhaustive)}`);
    }
  }
}

function formatFile(file: PiFileMetadata): string {
  const attributes = [
    attribute("kind", file.kind),
    attribute("name", file.name),
    attribute("status", file.status),
    optionalAttribute(
      "path",
      file.status === "available" ? file.path : undefined,
    ),
    optionalAttribute(
      "reason",
      file.status === "unavailable" ? file.reason : undefined,
    ),
    optionalAttribute(
      "limit",
      file.status === "unavailable" ? file.limitBytes?.toString() : undefined,
    ),
    optionalAttribute("mime", file.mimeType),
    optionalAttribute("size", file.size?.toString()),
    optionalAttribute("source", file.source),
    optionalAttribute("section", file.sourceSection),
    optionalAttribute("index", file.sourceIndex?.toString()),
    optionalAttribute("width", file.width?.toString()),
    optionalAttribute("height", file.height?.toString()),
    optionalAttribute("duration", file.duration?.toString()),
    optionalAttribute("length", file.length?.toString()),
    optionalAttribute("performer", file.performer),
    optionalAttribute("title", file.title),
    optionalAttribute("sticker_type", file.stickerType),
    optionalAttribute("format", file.format),
    optionalAttribute("emoji", file.emoji),
    optionalAttribute("set", file.setName),
    optionalAttribute("start", file.startTimestamp?.toString()),
  ].filter((item): item is string => item !== undefined);

  if (!file.transcription) return `<file ${attributes.join(" ")}/>`;
  const transcription = file.transcription;
  const metadata = [
    attribute("source", "telegram_voice"),
    attribute("method", "speech_to_text"),
    attribute("provider", transcription.provider),
    attribute("model", transcription.model),
    attribute("status", transcription.status),
    ...(transcription.status === "unavailable"
      ? [attribute("reason", transcription.code)]
      : []),
  ];
  const text =
    transcription.status === "completed"
      ? escapeXmlText(transcription.text)
      : "";
  return `<file ${attributes.join(" ")}><transcription ${metadata.join(" ")}>${text}</transcription></file>`;
}

function attribute(name: string, value: string): string {
  return `${name}="${escapeXmlAttribute(value)}"`;
}

function optionalAttribute(
  name: string,
  value: string | undefined,
): string | undefined {
  return value === undefined || value.length === 0
    ? undefined
    : attribute(name, value);
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value)
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
