import type {
  Chat,
  ExternalReplyInfo,
  Message,
  MessageEntity,
  MessageOrigin,
  PhotoSize,
  PollMedia,
  RichBlock,
  User,
} from "grammy/types";
import type {
  NormalizedTelegramMessage,
  ReferencedTelegramMessage,
  TelegramAttachment,
  TelegramAttachmentSource,
  TelegramContentKind,
  TelegramContentUnavailableReason,
  TelegramForwardOrigin,
  TelegramMessageContent,
  TelegramPollEmbeddedContent,
  TelegramReply,
} from "./types";
import {
  classifyTelegramContentMessage,
  type ClassifiedTelegramContentMessage,
} from "./content-types";
import { normalizeRichMessage } from "./rich";
import { telegramTimestamp } from "./time";

export type TelegramNormalizationResult =
  | { status: "supported"; message: NormalizedTelegramMessage }
  | {
      status: "unsupported";
      code: "missing_sender" | "unsupported_message";
      reason: string;
    };

export function normalizeTelegramMessage(
  updateId: number,
  message: Message,
): TelegramNormalizationResult {
  if (!message.from) {
    return {
      status: "unsupported",
      code: "missing_sender",
      reason: "消息没有可识别的发送者",
    };
  }

  const classified = classifyTelegramContentMessage(message);
  if (!classified) {
    return {
      status: "unsupported",
      code: "unsupported_message",
      reason: "消息不包含已支持的 Telegram 内容字段",
    };
  }

  let content: TelegramMessageContent;
  let attachments: TelegramAttachment[];
  let text: string;
  try {
    content = normalizeClassifiedContent(classified);
    attachments = extractAttachments(message);
    text = renderMessageText(message);
    if (!isUsableNormalizedInput(content, attachments, text)) {
      throw new Error("Telegram 内容缺少必需字段");
    }
  } catch {
    content = unavailableContent(classified.kind, "missing_fields");
    attachments = [];
    text = safeRenderMessageText(message);
  }

  const forward = message.forward_origin
    ? normalizeForwardOrigin(message.forward_origin)
    : undefined;
  const reply = normalizeReply(message);

  return {
    status: "supported",
    message: {
      updateId,
      chatId: message.chat.id,
      messageId: message.message_id,
      sentAt: telegramTimestamp(message.date),
      sender: normalizeSender(message.from),
      text,
      content,
      ...(message.media_group_id
        ? { mediaGroupId: message.media_group_id }
        : {}),
      ...(forward ? { forward } : {}),
      ...(reply ? { reply } : {}),
      attachments,
    },
  };
}

export function selectLargestPhoto(
  sizes: readonly PhotoSize[],
): PhotoSize | undefined {
  return sizes.reduce<PhotoSize | undefined>((largest, current) => {
    if (!largest) {
      return current;
    }
    const currentArea = current.width * current.height;
    const largestArea = largest.width * largest.height;
    if (currentArea !== largestArea) {
      return currentArea > largestArea ? current : largest;
    }
    return (current.file_size ?? 0) > (largest.file_size ?? 0)
      ? current
      : largest;
  }, undefined);
}

function normalizeSender(user: User): NormalizedTelegramMessage["sender"] {
  const displayName = [user.first_name, user.last_name]
    .filter(Boolean)
    .join(" ");
  return {
    id: user.id,
    displayName,
    ...(user.username ? { username: user.username } : {}),
  };
}

function normalizeReply(message: Message): TelegramReply | undefined {
  const quote = message.quote ? { text: message.quote.text } : undefined;

  if (message.reply_to_message) {
    const target = normalizeReplyTarget(message.reply_to_message);
    return {
      messageId: message.reply_to_message.message_id,
      ...(quote ? { quote } : {}),
      target,
    };
  }

  if (message.reply_to_story) {
    const story = {
      chatId: message.reply_to_story.chat.id,
      storyId: message.reply_to_story.id,
    };
    return {
      ...(quote ? { quote } : {}),
      story,
      target: {
        role: "user",
        sentAt: telegramTimestamp(message.date),
        text: "",
        content: { kind: "story", ...story },
        attachments: [],
      },
    };
  }

  if (message.external_reply) {
    const source = normalizeForwardOrigin(message.external_reply.origin);
    return {
      ...(message.external_reply.message_id !== undefined
        ? { messageId: message.external_reply.message_id }
        : {}),
      ...(quote ? { quote } : {}),
      externalSource: source,
      target: normalizeExternalReplyTarget(
        message.external_reply,
        quote?.text ?? "",
      ),
    };
  }

  return quote ? { quote } : undefined;
}

function normalizeReplyTarget(message: Message): ReferencedTelegramMessage {
  const forward = message.forward_origin
    ? normalizeForwardOrigin(message.forward_origin)
    : undefined;
  const classified = classifyTelegramContentMessage(message);
  let content: TelegramMessageContent | undefined;
  let attachments: TelegramAttachment[] = [];
  let text = safeRenderMessageText(message);
  if (classified) {
    try {
      content = normalizeClassifiedContent(classified);
      attachments = extractAttachments(message);
      if (!isUsableNormalizedInput(content, attachments, text)) {
        throw new Error("Telegram 引用内容缺少必需字段");
      }
    } catch {
      content = unavailableContent(classified.kind, "missing_fields");
      attachments = [];
    }
  }
  return {
    messageId: message.message_id,
    role: message.from?.is_bot ? "assistant" : "user",
    sentAt: telegramTimestamp(message.date),
    text,
    ...(content ? { content } : {}),
    ...(message.media_group_id ? { mediaGroupId: message.media_group_id } : {}),
    ...(forward ? { forward } : {}),
    attachments,
  };
}

function normalizeExternalReplyTarget(
  external: ExternalReplyInfo,
  quotedText: string,
): ReferencedTelegramMessage {
  const contentKind = externalContentKind(external);
  let content: TelegramMessageContent | undefined;
  let attachments: TelegramAttachment[] = [];
  if (contentKind) {
    try {
      content =
        normalizeMediaContent(external) ?? normalizeStructuredContent(external);
      attachments = extractExternalAttachments(external);
      if (
        !content ||
        !isUsableNormalizedInput(content, attachments, quotedText)
      ) {
        throw new Error("Telegram external reply 缺少必需字段");
      }
    } catch {
      content = unavailableContent(contentKind, "missing_fields");
      attachments = [];
    }
  }
  return {
    ...(external.message_id !== undefined
      ? { messageId: external.message_id }
      : {}),
    role: "user",
    sentAt: telegramTimestamp(external.origin.date),
    text: quotedText,
    forward: normalizeForwardOrigin(external.origin),
    ...(content ? { content } : {}),
    attachments,
  };
}

function externalContentKind(
  external: ExternalReplyInfo,
): TelegramContentKind | undefined {
  if (external.animation !== undefined) return "animation";
  if (external.audio !== undefined) return "audio";
  if (external.document !== undefined) return "document";
  if (external.live_photo !== undefined) return "live_photo";
  if (external.paid_media !== undefined) return "paid_media";
  if (external.photo !== undefined) return "photo";
  if (external.sticker !== undefined) return "sticker";
  if (external.story !== undefined) return "story";
  if (external.video !== undefined) return "video";
  if (external.video_note !== undefined) return "video_note";
  if (external.voice !== undefined) return "voice";
  if (external.contact !== undefined) return "contact";
  if (external.dice !== undefined) return "dice";
  if (external.game !== undefined) return "game";
  if (external.poll !== undefined) return "poll";
  if (external.venue !== undefined) return "venue";
  if (external.location !== undefined) return "location";
  if (external.checklist !== undefined) return "checklist";
  return undefined;
}

type MediaCarrier = Pick<
  Message,
  | "animation"
  | "audio"
  | "document"
  | "live_photo"
  | "paid_media"
  | "photo"
  | "sticker"
  | "story"
  | "video"
  | "video_note"
  | "voice"
>;

type StructuredCarrier = Pick<
  Message,
  "contact" | "dice" | "game" | "poll" | "venue" | "location" | "checklist"
>;

type TelegramFile = {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

function isTelegramFileLike(value: unknown): value is TelegramFile {
  return (
    isRecord(value) &&
    typeof value.file_id === "string" &&
    value.file_id.length > 0 &&
    typeof value.file_unique_id === "string" &&
    value.file_unique_id.length > 0
  );
}

function isPhotoSizeLike(value: unknown): value is PhotoSize {
  return (
    isTelegramFileLike(value) &&
    hasFiniteNumberField(value, "width") &&
    hasFiniteNumberField(value, "height")
  );
}

function isVideoLike(value: unknown): boolean {
  return (
    isTelegramFileLike(value) &&
    hasFiniteNumberField(value, "width") &&
    hasFiniteNumberField(value, "height") &&
    hasFiniteNumberField(value, "duration")
  );
}

function hasFiniteNumberField(value: unknown, field: string): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const fieldValue = value[field];
  return typeof fieldValue === "number" && Number.isFinite(fieldValue);
}

function isLivePhotoLike(value: unknown): boolean {
  return isVideoLike(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeClassifiedContent(
  classified: ClassifiedTelegramContentMessage,
): TelegramMessageContent {
  switch (classified.kind) {
    case "text":
      return { kind: "text" };
    case "rich_message": {
      const rich = normalizeRichMessage(classified.message.rich_message);
      return {
        kind: "rich_message",
        blockTypes: rich.blockTypes,
        ...(rich.unavailableBlockCount > 0
          ? {
              unavailableBlockCount: rich.unavailableBlockCount,
              unavailableReasons: rich.unavailableReasons,
            }
          : {}),
      };
    }
    case "animation":
    case "audio":
    case "document":
    case "live_photo":
    case "paid_media":
    case "photo":
    case "sticker":
    case "story":
    case "video":
    case "video_note":
    case "voice": {
      const content = normalizeMediaContent(classified.message);
      if (!content) {
        throw new Error(`无法归一化已分类媒体：${classified.kind}`);
      }
      return content;
    }
    case "contact":
    case "dice":
    case "game":
    case "poll":
    case "venue":
    case "location":
    case "checklist": {
      const content = normalizeStructuredContent(classified.message);
      if (!content) {
        throw new Error(`无法归一化已分类内容：${classified.kind}`);
      }
      return content;
    }
    default: {
      const exhaustive: never = classified;
      throw new Error(`未知 Telegram 内容分类：${String(exhaustive)}`);
    }
  }
}

function unavailableContent(
  contentKind: TelegramContentKind,
  reason: TelegramContentUnavailableReason,
): TelegramMessageContent {
  return { kind: "unavailable", contentKind, reasons: [reason] };
}

function safeRenderMessageText(message: Message): string {
  try {
    return renderMessageText(message);
  } catch {
    return "";
  }
}

function isUsableNormalizedInput(
  content: TelegramMessageContent,
  attachments: readonly TelegramAttachment[],
  text: string,
): boolean {
  if (content.kind === "unavailable") {
    return content.reasons.length > 0;
  }
  if (!attachments.every(isUsableAttachment)) {
    return false;
  }

  switch (content.kind) {
    case "text":
      return text.length > 0;
    case "animation":
    case "audio":
    case "document":
    case "live_photo":
    case "photo":
    case "sticker":
    case "video":
    case "video_note":
    case "voice":
      return attachments.length > 0;
    case "rich_message":
      return (
        content.blockTypes.length > 0 &&
        (text.length > 0 || attachments.length > 0)
      );
    case "paid_media":
      return (
        Number.isSafeInteger(content.starCount) &&
        content.starCount >= 0 &&
        Number.isSafeInteger(content.itemCount) &&
        content.itemCount > 0 &&
        Number.isSafeInteger(content.unavailableItemCount) &&
        content.unavailableItemCount >= 0
      );
    case "story":
      return (
        Number.isSafeInteger(content.chatId) &&
        Number.isSafeInteger(content.storyId)
      );
    case "contact":
      return (
        typeof content.phoneNumber === "string" &&
        content.phoneNumber.length > 0 &&
        typeof content.firstName === "string" &&
        content.firstName.length > 0
      );
    case "dice":
      return (
        typeof content.emoji === "string" &&
        content.emoji.length > 0 &&
        Number.isSafeInteger(content.value)
      );
    case "game":
      return (
        typeof content.title === "string" &&
        content.title.length > 0 &&
        typeof content.description === "string" &&
        typeof content.text === "string"
      );
    case "poll":
      return (
        typeof content.question === "string" &&
        content.question.length > 0 &&
        content.options.length > 0 &&
        content.options.every(
          (option) =>
            typeof option.text === "string" &&
            option.text.length > 0 &&
            Number.isSafeInteger(option.voterCount),
        )
      );
    case "venue":
      return (
        Number.isFinite(content.latitude) &&
        Number.isFinite(content.longitude) &&
        typeof content.title === "string" &&
        content.title.length > 0 &&
        typeof content.address === "string"
      );
    case "location":
      return (
        Number.isFinite(content.latitude) && Number.isFinite(content.longitude)
      );
    case "checklist":
      return (
        typeof content.title === "string" &&
        content.title.length > 0 &&
        content.tasks.length > 0 &&
        content.tasks.every(
          (task) =>
            Number.isSafeInteger(task.id) &&
            typeof task.text === "string" &&
            task.text.length > 0,
        )
      );
    default: {
      const exhaustive: never = content;
      return exhaustive;
    }
  }
}

function isUsableAttachment(attachment: TelegramAttachment): boolean {
  if (
    typeof attachment.fileId !== "string" ||
    attachment.fileId.length === 0 ||
    typeof attachment.fileUniqueId !== "string" ||
    attachment.fileUniqueId.length === 0
  ) {
    return false;
  }

  switch (attachment.kind) {
    case "animation":
    case "live_photo":
    case "video":
      return (
        Number.isFinite(attachment.width) &&
        Number.isFinite(attachment.height) &&
        Number.isFinite(attachment.duration)
      );
    case "audio":
    case "voice":
      return Number.isFinite(attachment.duration);
    case "document":
      return true;
    case "photo":
      return (
        Number.isFinite(attachment.width) && Number.isFinite(attachment.height)
      );
    case "sticker":
      return (
        Number.isFinite(attachment.width) &&
        Number.isFinite(attachment.height) &&
        ["regular", "mask", "custom_emoji"].includes(attachment.stickerType) &&
        ["static", "animated", "video"].includes(attachment.format)
      );
    case "video_note":
      return (
        Number.isFinite(attachment.length) &&
        Number.isFinite(attachment.duration)
      );
    default: {
      const exhaustive: never = attachment;
      return exhaustive;
    }
  }
}

function normalizeStructuredContent(
  message: StructuredCarrier,
): TelegramMessageContent | undefined {
  if (message.contact) {
    return {
      kind: "contact",
      phoneNumber: message.contact.phone_number,
      firstName: message.contact.first_name,
      ...(message.contact.last_name
        ? { lastName: message.contact.last_name }
        : {}),
      ...(message.contact.user_id !== undefined
        ? { userId: message.contact.user_id }
        : {}),
      ...(message.contact.vcard ? { vcard: message.contact.vcard } : {}),
    };
  }
  if (message.dice) {
    return {
      kind: "dice",
      emoji: message.dice.emoji,
      value: message.dice.value,
    };
  }
  if (message.game) {
    return {
      kind: "game",
      title: message.game.title,
      description: message.game.description,
      text: renderTextLinks(message.game.text, message.game.text_entities),
    };
  }
  if (message.poll) {
    const media = normalizePollEmbeddedContent(message.poll);
    return {
      kind: "poll",
      question: renderTextLinks(
        message.poll.question,
        message.poll.question_entities ?? [],
      ),
      options: message.poll.options.map((option) => ({
        text: renderTextLinks(option.text, option.text_entities ?? []),
        voterCount: option.voter_count,
      })),
      totalVoterCount: message.poll.total_voter_count,
      closed: message.poll.is_closed,
      anonymous: message.poll.is_anonymous,
      pollType: message.poll.type,
      multipleAnswers: message.poll.allows_multiple_answers,
      allowsRevoting: message.poll.allows_revoting,
      membersOnly: message.poll.members_only,
      ...(message.poll.correct_option_ids
        ? { correctOptionIds: message.poll.correct_option_ids }
        : {}),
      ...(message.poll.country_codes
        ? { countryCodes: message.poll.country_codes }
        : {}),
      ...(message.poll.explanation
        ? {
            explanation: renderTextLinks(
              message.poll.explanation,
              message.poll.explanation_entities ?? [],
            ),
          }
        : {}),
      ...(message.poll.description
        ? {
            description: renderTextLinks(
              message.poll.description,
              message.poll.description_entities ?? [],
            ),
          }
        : {}),
      ...(message.poll.open_period !== undefined
        ? { openPeriod: message.poll.open_period }
        : {}),
      ...(message.poll.close_date !== undefined
        ? { closeDate: message.poll.close_date }
        : {}),
      ...(media.length > 0 ? { media } : {}),
    };
  }
  if (message.venue) {
    return {
      kind: "venue",
      latitude: message.venue.location.latitude,
      longitude: message.venue.location.longitude,
      title: message.venue.title,
      address: message.venue.address,
      ...(message.venue.foursquare_id
        ? { foursquareId: message.venue.foursquare_id }
        : {}),
      ...(message.venue.foursquare_type
        ? { foursquareType: message.venue.foursquare_type }
        : {}),
      ...(message.venue.google_place_id
        ? { googlePlaceId: message.venue.google_place_id }
        : {}),
      ...(message.venue.google_place_type
        ? { googlePlaceType: message.venue.google_place_type }
        : {}),
    };
  }
  if (message.location) {
    return {
      kind: "location",
      latitude: message.location.latitude,
      longitude: message.location.longitude,
      ...(message.location.horizontal_accuracy !== undefined
        ? { horizontalAccuracy: message.location.horizontal_accuracy }
        : {}),
      ...(message.location.live_period !== undefined
        ? { livePeriod: message.location.live_period }
        : {}),
      ...(message.location.heading !== undefined
        ? { heading: message.location.heading }
        : {}),
      ...(message.location.proximity_alert_radius !== undefined
        ? { proximityAlertRadius: message.location.proximity_alert_radius }
        : {}),
    };
  }
  if (message.checklist) {
    return {
      kind: "checklist",
      title: renderTextLinks(
        message.checklist.title,
        message.checklist.title_entities ?? [],
      ),
      tasks: message.checklist.tasks.map((task) => ({
        id: task.id,
        text: renderTextLinks(task.text, task.text_entities ?? []),
        completed:
          (task.completion_date !== undefined && task.completion_date > 0) ||
          task.completed_by_user !== undefined ||
          task.completed_by_chat !== undefined,
        ...(task.completion_date !== undefined
          ? { completionDate: task.completion_date }
          : {}),
        ...(task.completed_by_user
          ? { completedByUserId: task.completed_by_user.id }
          : {}),
        ...(task.completed_by_chat
          ? { completedByChatId: task.completed_by_chat.id }
          : {}),
      })),
      othersCanAddTasks: message.checklist.others_can_add_tasks === true,
      othersCanMarkTasksDone:
        message.checklist.others_can_mark_tasks_as_done === true,
    };
  }
  return undefined;
}

function normalizeMediaContent(
  carrier: MediaCarrier,
): TelegramMessageContent | undefined {
  if (carrier.animation) return { kind: "animation" };
  if (carrier.audio) return { kind: "audio" };
  if (carrier.document) return { kind: "document" };
  if (carrier.live_photo) return { kind: "live_photo" };
  if (carrier.paid_media) {
    const unavailable = paidMediaUnavailableState(
      carrier.paid_media.paid_media,
    );
    const previews = paidMediaPreviews(carrier.paid_media.paid_media);
    return {
      kind: "paid_media",
      starCount: carrier.paid_media.star_count,
      itemCount: carrier.paid_media.paid_media.length,
      unavailableItemCount: unavailable.count,
      ...(unavailable.reasons.length > 0
        ? { unavailableReasons: unavailable.reasons }
        : {}),
      ...(previews.length > 0 ? { previews } : {}),
    };
  }
  if (carrier.photo) return { kind: "photo" };
  if (carrier.sticker) return { kind: "sticker" };
  if (carrier.story) {
    return {
      kind: "story",
      chatId: carrier.story.chat.id,
      storyId: carrier.story.id,
    };
  }
  if (carrier.video) return { kind: "video" };
  if (carrier.video_note) return { kind: "video_note" };
  if (carrier.voice) return { kind: "voice" };
  return undefined;
}

function paidMediaPreviews(
  items: NonNullable<Message["paid_media"]>["paid_media"],
): Array<{
  index: number;
  width?: number;
  height?: number;
  duration?: number;
}> {
  return items.flatMap((item, index) => {
    if (item.type !== "preview") {
      return [];
    }
    return [
      {
        index,
        ...(item.width !== undefined ? { width: item.width } : {}),
        ...(item.height !== undefined ? { height: item.height } : {}),
        ...(item.duration !== undefined ? { duration: item.duration } : {}),
      },
    ];
  });
}

function paidMediaUnavailableState(
  items: NonNullable<Message["paid_media"]>["paid_media"],
): { count: number; reasons: TelegramContentUnavailableReason[] } {
  let count = 0;
  const reasons = new Set<TelegramContentUnavailableReason>();
  for (const item of items) {
    switch (item.type) {
      case "preview":
        count += 1;
        reasons.add("content_unavailable");
        break;
      case "live_photo":
        if (!isLivePhotoLike(item.live_photo)) {
          count += 1;
          reasons.add("missing_fields");
        }
        break;
      case "photo":
        if (!Array.isArray(item.photo) || !item.photo.some(isPhotoSizeLike)) {
          count += 1;
          reasons.add("missing_fields");
        }
        break;
      case "video":
        if (!isVideoLike(item.video)) {
          count += 1;
          reasons.add("missing_fields");
        }
        break;
      default: {
        const exhaustive: never = item;
        void exhaustive;
        count += 1;
        reasons.add("unsupported_nested_type");
      }
    }
  }
  return { count, reasons: [...reasons] };
}

function extractAttachments(message: Message): TelegramAttachment[] {
  if (message.rich_message) {
    return extractRichAttachments(message.rich_message.blocks);
  }
  const media = extractMediaAttachments(message);
  if (media.length > 0 || normalizeMediaContent(message)) {
    return media;
  }
  if (message.game) {
    const photo = selectLargestPhoto(message.game.photo);
    return [
      ...(photo ? [normalizePhoto(photo, "game", 0)] : []),
      normalizeAnimation(message.game.animation, "game", 1),
    ];
  }
  if (message.poll) {
    return extractPollAttachments(message.poll);
  }
  return [];
}

function extractExternalAttachments(
  external: ExternalReplyInfo,
): TelegramAttachment[] {
  const media = extractMediaAttachments(external);
  if (media.length > 0 || normalizeMediaContent(external)) {
    return media;
  }
  if (external.game) {
    const photo = selectLargestPhoto(external.game.photo);
    return [
      ...(photo ? [normalizePhoto(photo, "game", 0)] : []),
      normalizeAnimation(external.game.animation, "game", 1),
    ];
  }
  if (external.poll) {
    return extractPollAttachments(external.poll);
  }
  return [];
}

function extractMediaAttachments(carrier: MediaCarrier): TelegramAttachment[] {
  if (carrier.animation) return [normalizeAnimation(carrier.animation)];
  if (carrier.audio) return [normalizeAudio(carrier.audio)];
  if (carrier.document) return [normalizeDocument(carrier.document)];
  if (carrier.live_photo) return normalizeLivePhoto(carrier.live_photo);
  if (carrier.paid_media) {
    return carrier.paid_media.paid_media.flatMap((item, index) => {
      switch (item.type) {
        case "photo": {
          if (!Array.isArray(item.photo)) {
            return [];
          }
          const photo = selectLargestPhoto(item.photo.filter(isPhotoSizeLike));
          return photo ? [normalizePhoto(photo, "paid_media", index)] : [];
        }
        case "video":
          return isVideoLike(item.video)
            ? [normalizeVideo(item.video, "paid_media", index)]
            : [];
        case "live_photo":
          return isLivePhotoLike(item.live_photo)
            ? normalizeLivePhoto(item.live_photo, "paid_media", index)
            : [];
        case "preview":
          return [];
        default: {
          const exhaustive: never = item;
          void exhaustive;
          return [];
        }
      }
    });
  }
  if (carrier.photo) {
    const photo = selectLargestPhoto(carrier.photo);
    return photo ? [normalizePhoto(photo)] : [];
  }
  if (carrier.sticker) return [normalizeSticker(carrier.sticker)];
  if (carrier.video) return [normalizeVideo(carrier.video)];
  if (carrier.video_note) return [normalizeVideoNote(carrier.video_note)];
  if (carrier.voice) return [normalizeVoice(carrier.voice)];
  return [];
}

type PollMediaPosition =
  | { section: "description" | "explanation" }
  | { section: "option"; optionIndex: number };

function normalizePollEmbeddedContent(
  poll: NonNullable<Message["poll"]>,
): TelegramPollEmbeddedContent[] {
  const normalized: TelegramPollEmbeddedContent[] = [];
  const append = (
    media: PollMedia | undefined,
    position: PollMediaPosition,
  ): void => {
    if (!media) {
      return;
    }
    if (media.link) {
      normalized.push({ ...position, kind: "link", url: media.link.url });
    } else if (media.venue) {
      normalized.push({
        ...position,
        kind: "venue",
        latitude: media.venue.location.latitude,
        longitude: media.venue.location.longitude,
        title: media.venue.title,
        address: media.venue.address,
      });
    } else if (media.location) {
      normalized.push({
        ...position,
        kind: "location",
        latitude: media.location.latitude,
        longitude: media.location.longitude,
        ...(media.location.horizontal_accuracy !== undefined
          ? { horizontalAccuracy: media.location.horizontal_accuracy }
          : {}),
      });
    }
  };

  append(poll.media, { section: "description" });
  append(poll.explanation_media, { section: "explanation" });
  poll.options.forEach((option, optionIndex) => {
    append(option.media, { section: "option", optionIndex });
  });
  return normalized;
}

function extractPollAttachments(
  poll: NonNullable<Message["poll"]>,
): TelegramAttachment[] {
  const attachments: TelegramAttachment[] = [];
  const append = (
    media: PollMedia | undefined,
    position: PollMediaPosition,
  ): void => {
    if (!media) {
      return;
    }
    attachments.push(...extractPollMediaAttachments(media, position));
  };

  append(poll.media, { section: "description" });
  append(poll.explanation_media, { section: "explanation" });
  poll.options.forEach((option, optionIndex) => {
    append(option.media, { section: "option", optionIndex });
  });
  return attachments;
}

function extractPollMediaAttachments(
  media: PollMedia,
  position: PollMediaPosition,
): TelegramAttachment[] {
  const sourceIndex =
    position.section === "option" ? position.optionIndex : undefined;
  let attachments: TelegramAttachment[];
  if (media.animation) {
    attachments = [normalizeAnimation(media.animation, "poll", sourceIndex)];
  } else if (media.audio) {
    attachments = [normalizeAudio(media.audio, "poll", sourceIndex)];
  } else if (media.document) {
    attachments = [normalizeDocument(media.document, "poll", sourceIndex)];
  } else if (media.live_photo) {
    attachments = normalizeLivePhoto(media.live_photo, "poll", sourceIndex);
  } else if (media.photo) {
    const photo = selectLargestPhoto(media.photo);
    attachments = photo ? [normalizePhoto(photo, "poll", sourceIndex)] : [];
  } else if (media.sticker) {
    attachments = [normalizeSticker(media.sticker, "poll", sourceIndex)];
  } else if (media.video) {
    attachments = [normalizeVideo(media.video, "poll", sourceIndex)];
  } else {
    attachments = [];
  }
  return attachments.map((attachment) => ({
    ...attachment,
    sourceSection: position.section,
  }));
}

function extractRichAttachments(
  blocks: readonly RichBlock[],
): TelegramAttachment[] {
  const attachments: TelegramAttachment[] = [];
  let sourceIndex = 0;

  const visit = (items: readonly RichBlock[]): void => {
    for (const block of items) {
      switch (block.type) {
        case "animation":
          attachments.push(
            normalizeAnimation(block.animation, "rich_message", sourceIndex++),
          );
          break;
        case "audio":
          attachments.push(
            normalizeAudio(block.audio, "rich_message", sourceIndex++),
          );
          break;
        case "document":
          attachments.push(
            normalizeDocument(block.document, "rich_message", sourceIndex++),
          );
          break;
        case "photo": {
          const photo = selectLargestPhoto(block.photo);
          if (photo) {
            attachments.push(
              normalizePhoto(photo, "rich_message", sourceIndex++),
            );
          }
          break;
        }
        case "video":
          attachments.push(
            normalizeVideo(block.video, "rich_message", sourceIndex++),
          );
          break;
        case "voice_note":
          attachments.push(
            normalizeVoice(block.voice_note, "rich_message", sourceIndex++),
          );
          break;
        case "list":
          for (const item of block.items) {
            visit(item.blocks);
          }
          break;
        case "blockquote":
        case "collage":
        case "slideshow":
        case "details":
          visit(block.blocks);
          break;
        case "paragraph":
        case "heading":
        case "pre":
        case "footer":
        case "divider":
        case "mathematical_expression":
        case "anchor":
        case "expandable_blockquote":
        case "pullquote":
        case "buttons":
        case "table":
        case "map":
        case "thinking":
          break;
        default: {
          const exhaustive: never = block;
          void exhaustive;
          break;
        }
      }
    }
  };

  visit(blocks);
  return attachments;
}

function normalizeFileBase(
  file: TelegramFile,
  source?: TelegramAttachmentSource,
  sourceIndex?: number,
) {
  return {
    fileId: file.file_id,
    fileUniqueId: file.file_unique_id,
    ...(file.file_name ? { fileName: file.file_name } : {}),
    ...(file.mime_type ? { mimeType: file.mime_type } : {}),
    ...(file.file_size !== undefined ? { size: file.file_size } : {}),
    ...(source ? { source } : {}),
    ...(sourceIndex !== undefined ? { sourceIndex } : {}),
  };
}

function normalizeAnimation(
  animation: NonNullable<Message["animation"]>,
  source?: TelegramAttachmentSource,
  sourceIndex?: number,
): TelegramAttachment {
  return {
    kind: "animation",
    ...normalizeFileBase(animation, source, sourceIndex),
    width: animation.width,
    height: animation.height,
    duration: animation.duration,
  };
}

function normalizeAudio(
  audio: NonNullable<Message["audio"]>,
  source?: TelegramAttachmentSource,
  sourceIndex?: number,
): TelegramAttachment {
  return {
    kind: "audio",
    ...normalizeFileBase(audio, source, sourceIndex),
    duration: audio.duration,
    ...(audio.performer ? { performer: audio.performer } : {}),
    ...(audio.title ? { title: audio.title } : {}),
  };
}

function normalizeDocument(
  document: NonNullable<Message["document"]>,
  source?: TelegramAttachmentSource,
  sourceIndex?: number,
): TelegramAttachment {
  return {
    kind: "document",
    ...normalizeFileBase(document, source, sourceIndex),
  };
}

function normalizeLivePhoto(
  livePhoto: NonNullable<Message["live_photo"]>,
  source?: TelegramAttachmentSource,
  sourceIndex?: number,
): TelegramAttachment[] {
  const photo = livePhoto.photo
    ? selectLargestPhoto(livePhoto.photo)
    : undefined;
  return [
    ...(photo ? [normalizePhoto(photo, source, sourceIndex)] : []),
    {
      kind: "live_photo" as const,
      ...normalizeFileBase(livePhoto, source, sourceIndex),
      width: livePhoto.width,
      height: livePhoto.height,
      duration: livePhoto.duration,
    },
  ];
}

function normalizePhoto(
  photo: PhotoSize,
  source?: TelegramAttachmentSource,
  sourceIndex?: number,
): TelegramAttachment {
  return {
    kind: "photo",
    fileId: photo.file_id,
    fileUniqueId: photo.file_unique_id,
    width: photo.width,
    height: photo.height,
    ...(photo.file_size !== undefined ? { size: photo.file_size } : {}),
    ...(source ? { source } : {}),
    ...(sourceIndex !== undefined ? { sourceIndex } : {}),
  };
}

function normalizeSticker(
  sticker: NonNullable<Message["sticker"]>,
  source?: TelegramAttachmentSource,
  sourceIndex?: number,
): TelegramAttachment {
  return {
    kind: "sticker",
    ...normalizeFileBase(sticker, source, sourceIndex),
    width: sticker.width,
    height: sticker.height,
    stickerType: sticker.type,
    format: sticker.is_animated
      ? "animated"
      : sticker.is_video
        ? "video"
        : "static",
    ...(sticker.emoji ? { emoji: sticker.emoji } : {}),
    ...(sticker.set_name ? { setName: sticker.set_name } : {}),
  };
}

function normalizeVideo(
  video: NonNullable<Message["video"]>,
  source?: TelegramAttachmentSource,
  sourceIndex?: number,
): TelegramAttachment {
  return {
    kind: "video",
    ...normalizeFileBase(video, source, sourceIndex),
    width: video.width,
    height: video.height,
    duration: video.duration,
    ...(video.start_timestamp !== undefined
      ? { startTimestamp: video.start_timestamp }
      : {}),
  };
}

function normalizeVideoNote(
  videoNote: NonNullable<Message["video_note"]>,
  source?: TelegramAttachmentSource,
  sourceIndex?: number,
): TelegramAttachment {
  return {
    kind: "video_note",
    ...normalizeFileBase(videoNote, source, sourceIndex),
    mimeType: "video/mp4",
    length: videoNote.length,
    duration: videoNote.duration,
  };
}

function normalizeVoice(
  voice: NonNullable<Message["voice"]>,
  source?: TelegramAttachmentSource,
  sourceIndex?: number,
): TelegramAttachment {
  return {
    kind: "voice",
    ...normalizeFileBase(voice, source, sourceIndex),
    duration: voice.duration,
  };
}

export function normalizeForwardOrigin(
  origin: MessageOrigin,
): TelegramForwardOrigin {
  const sentAt = telegramTimestamp(origin.date);

  switch (origin.type) {
    case "user": {
      const displayName = [
        origin.sender_user.first_name,
        origin.sender_user.last_name,
      ]
        .filter(Boolean)
        .join(" ");
      return {
        kind: "user",
        id: origin.sender_user.id,
        displayName,
        ...(origin.sender_user.username
          ? { username: origin.sender_user.username }
          : {}),
        isBot: origin.sender_user.is_bot,
        sentAt,
      };
    }
    case "hidden_user":
      return {
        kind: "hidden_user",
        displayName: origin.sender_user_name,
        sentAt,
      };
    case "chat":
      return {
        kind: "chat",
        id: origin.sender_chat.id,
        title: chatDisplayName(origin.sender_chat),
        ...("username" in origin.sender_chat && origin.sender_chat.username
          ? { username: origin.sender_chat.username }
          : {}),
        sentAt,
      };
    case "channel":
      return {
        kind: "channel",
        id: origin.chat.id,
        title: origin.chat.title,
        ...(origin.chat.username ? { username: origin.chat.username } : {}),
        messageId: origin.message_id,
        sentAt,
      };
    default: {
      const exhaustive: never = origin;
      throw new Error(`未知 Telegram 转发来源：${String(exhaustive)}`);
    }
  }
}

function chatDisplayName(chat: Chat): string {
  if (chat.title) {
    return chat.title;
  }
  return (
    [chat.first_name, chat.last_name].filter(Boolean).join(" ") ||
    String(chat.id)
  );
}

function renderMessageText(message: Message): string {
  if (message.text !== undefined) {
    return renderTextLinks(message.text, message.entities ?? []);
  }
  if (message.caption !== undefined) {
    return renderTextLinks(message.caption, message.caption_entities ?? []);
  }
  if (message.rich_message) {
    return normalizeRichMessage(message.rich_message).text;
  }
  return "";
}

export function renderTextLinks(
  text: string,
  entities: readonly MessageEntity[],
): string {
  const links = entities
    .filter(
      (entity) => entity.type === "text_link" || entity.type === "text_mention",
    )
    .sort((left, right) => right.offset - left.offset);

  let rendered = text;
  for (const entity of links) {
    const start = entity.offset;
    const end = start + entity.length;
    const label = text.slice(start, end);
    const target =
      entity.type === "text_link"
        ? entity.url
        : entity.user.username
          ? `https://t.me/${entity.user.username}`
          : `tg://user?id=${entity.user.id}`;

    if (label === target) {
      continue;
    }
    rendered = `${rendered.slice(0, end)} (${target})${rendered.slice(end)}`;
  }
  return rendered;
}
