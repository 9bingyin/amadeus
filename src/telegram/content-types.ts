import type { Message } from "grammy/types";
import type { TelegramContentKind } from "./types";

interface TelegramContentAliasByKind {
  text: Message.TextMessage;
  rich_message: Message.RichMessageMessage;
  animation: Message.AnimationMessage;
  audio: Message.AudioMessage;
  document: Message.DocumentMessage;
  live_photo: Message.LivePhotoMessage;
  paid_media: Message.PaidMediaMessage;
  photo: Message.PhotoMessage;
  sticker: Message.StickerMessage;
  story: Message.StoryMessage;
  video: Message.VideoMessage;
  video_note: Message.VideoNoteMessage;
  voice: Message.VoiceMessage;
  contact: Message.ContactMessage;
  dice: Message.DiceMessage;
  game: Message.GameMessage;
  poll: Message.PollMessage;
  venue: Message.VenueMessage;
  location: Message.LocationMessage;
  checklist: Message.ChecklistMessage;
}

type MessageWith<Field extends keyof Message> = Message & {
  [Key in Field]-?: NonNullable<Message[Key]>;
};

export interface TelegramContentMessageByKind {
  text: MessageWith<"text">;
  rich_message: MessageWith<"rich_message">;
  animation: MessageWith<"animation">;
  audio: MessageWith<"audio">;
  document: MessageWith<"document">;
  live_photo: MessageWith<"live_photo">;
  paid_media: MessageWith<"paid_media">;
  photo: MessageWith<"photo">;
  sticker: MessageWith<"sticker">;
  story: MessageWith<"story">;
  video: MessageWith<"video">;
  video_note: MessageWith<"video_note">;
  voice: MessageWith<"voice">;
  contact: MessageWith<"contact">;
  dice: MessageWith<"dice">;
  game: MessageWith<"game">;
  poll: MessageWith<"poll">;
  venue: MessageWith<"venue">;
  location: MessageWith<"location">;
  checklist: MessageWith<"checklist">;
}

type ExpectedContentKind = TelegramContentKind;

type AssertNever<Value extends never> = Value;

export type MissingNormalizedTelegramContentKind = Exclude<
  ExpectedContentKind,
  keyof TelegramContentMessageByKind
>;
export type ExtraNormalizedTelegramContentKind = Exclude<
  keyof TelegramContentMessageByKind,
  ExpectedContentKind
>;

export type ClassifiedTelegramContentMessage = {
  [Kind in TelegramContentKind]: {
    kind: Kind;
    message: TelegramContentMessageByKind[Kind];
  };
}[TelegramContentKind];

export const TELEGRAM_CONTENT_KIND_ORDER = [
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
] as const satisfies readonly TelegramContentKind[];

export type MissingTelegramContentClassifier = Exclude<
  TelegramContentKind,
  (typeof TELEGRAM_CONTENT_KIND_ORDER)[number]
>;

type MissingTelegramContentAlias = Exclude<
  TelegramContentKind,
  keyof TelegramContentAliasByKind
>;
type ExtraTelegramContentAlias = Exclude<
  keyof TelegramContentAliasByKind,
  TelegramContentKind
>;

export type TelegramContentCoverageCheck = AssertNever<
  | MissingNormalizedTelegramContentKind
  | ExtraNormalizedTelegramContentKind
  | MissingTelegramContentClassifier
  | MissingTelegramContentAlias
  | ExtraTelegramContentAlias
>;

export function classifyTelegramContentMessage(
  message: Message,
): ClassifiedTelegramContentMessage | undefined {
  if (hasContentField(message, "text")) return { kind: "text", message };
  if (hasContentField(message, "rich_message")) {
    return { kind: "rich_message", message };
  }
  if (hasContentField(message, "animation")) {
    return { kind: "animation", message };
  }
  if (hasContentField(message, "audio")) return { kind: "audio", message };
  if (hasContentField(message, "document")) {
    return { kind: "document", message };
  }
  if (hasContentField(message, "live_photo")) {
    return { kind: "live_photo", message };
  }
  if (hasContentField(message, "paid_media")) {
    return { kind: "paid_media", message };
  }
  if (hasContentField(message, "photo")) return { kind: "photo", message };
  if (hasContentField(message, "sticker")) {
    return { kind: "sticker", message };
  }
  if (hasContentField(message, "story")) return { kind: "story", message };
  if (hasContentField(message, "video")) return { kind: "video", message };
  if (hasContentField(message, "video_note")) {
    return { kind: "video_note", message };
  }
  if (hasContentField(message, "voice")) return { kind: "voice", message };
  if (hasContentField(message, "contact")) {
    return { kind: "contact", message };
  }
  if (hasContentField(message, "dice")) return { kind: "dice", message };
  if (hasContentField(message, "game")) return { kind: "game", message };
  if (hasContentField(message, "poll")) return { kind: "poll", message };
  if (hasContentField(message, "venue")) return { kind: "venue", message };
  if (hasContentField(message, "location")) {
    return { kind: "location", message };
  }
  if (hasContentField(message, "checklist")) {
    return { kind: "checklist", message };
  }
  return undefined;
}

function hasContentField<Field extends keyof Message>(
  message: Message,
  field: Field,
): message is MessageWith<Field> {
  return message[field] !== undefined;
}
