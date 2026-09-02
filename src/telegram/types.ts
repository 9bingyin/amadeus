export type TelegramForwardOrigin =
  | {
      kind: "user";
      id: number;
      displayName: string;
      username?: string;
      isBot: boolean;
      sentAt: string;
    }
  | {
      kind: "hidden_user";
      displayName: string;
      sentAt: string;
    }
  | {
      kind: "chat";
      id: number;
      title: string;
      username?: string;
      sentAt: string;
    }
  | {
      kind: "channel";
      id: number;
      title: string;
      username?: string;
      messageId: number;
      sentAt: string;
    };

export const TELEGRAM_PUBLIC_FILE_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

export type TelegramAttachmentUnavailableReason =
  "telegram_public_api_limit" | "download_failed" | "content_unavailable";

export type TelegramContentUnavailableReason =
  "content_unavailable" | "unsupported_nested_type" | "missing_fields";

export type TelegramAttachmentKind =
  | "animation"
  | "audio"
  | "document"
  | "live_photo"
  | "photo"
  | "sticker"
  | "video"
  | "video_note"
  | "voice";

export type TelegramAttachmentSource =
  "message" | "paid_media" | "poll" | "game" | "rich_message";

export type TelegramPollMediaSection = "description" | "explanation" | "option";

interface TelegramAttachmentBase {
  fileId: string;
  fileUniqueId: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
  source?: TelegramAttachmentSource;
  sourceSection?: TelegramPollMediaSection;
  sourceIndex?: number;
  localPath?: string;
  unavailableReason?: TelegramAttachmentUnavailableReason;
}

export type TelegramAttachment =
  | (TelegramAttachmentBase & {
      kind: "animation";
      width: number;
      height: number;
      duration: number;
    })
  | (TelegramAttachmentBase & {
      kind: "audio";
      duration: number;
      performer?: string;
      title?: string;
    })
  | (TelegramAttachmentBase & { kind: "document" })
  | (TelegramAttachmentBase & {
      kind: "live_photo";
      width: number;
      height: number;
      duration: number;
    })
  | (TelegramAttachmentBase & {
      kind: "photo";
      width: number;
      height: number;
    })
  | (TelegramAttachmentBase & {
      kind: "sticker";
      width: number;
      height: number;
      stickerType: "regular" | "mask" | "custom_emoji";
      format: "static" | "animated" | "video";
      emoji?: string;
      setName?: string;
    })
  | (TelegramAttachmentBase & {
      kind: "video";
      width: number;
      height: number;
      duration: number;
      startTimestamp?: number;
    })
  | (TelegramAttachmentBase & {
      kind: "video_note";
      length: number;
      duration: number;
    })
  | (TelegramAttachmentBase & {
      kind: "voice";
      duration: number;
    });

export interface TelegramPaidMediaPreview {
  index: number;
  width?: number;
  height?: number;
  duration?: number;
}

export interface TelegramPollOption {
  text: string;
  voterCount: number;
}

type TelegramPollMediaPosition =
  | { section: "description" | "explanation" }
  | { section: "option"; optionIndex: number };

export type TelegramPollEmbeddedContent = TelegramPollMediaPosition &
  (
    | { kind: "link"; url: string }
    | {
        kind: "location";
        latitude: number;
        longitude: number;
        horizontalAccuracy?: number;
      }
    | {
        kind: "venue";
        latitude: number;
        longitude: number;
        title: string;
        address: string;
      }
  );

export interface TelegramChecklistTask {
  id: number;
  text: string;
  completed: boolean;
  completionDate?: number;
  completedByUserId?: number;
  completedByChatId?: number;
}

export type TelegramContentKind =
  | "text"
  | "rich_message"
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
  | "contact"
  | "dice"
  | "game"
  | "poll"
  | "venue"
  | "location"
  | "checklist";

export type TelegramMessageContentData =
  | { kind: "text" }
  | {
      kind: "rich_message";
      blockTypes: string[];
      unavailableBlockCount?: number;
      unavailableReasons?: TelegramContentUnavailableReason[];
    }
  | { kind: "animation" }
  | { kind: "audio" }
  | { kind: "document" }
  | { kind: "live_photo" }
  | {
      kind: "paid_media";
      starCount: number;
      itemCount: number;
      unavailableItemCount: number;
      unavailableReasons?: TelegramContentUnavailableReason[];
      previews?: TelegramPaidMediaPreview[];
    }
  | { kind: "photo" }
  | { kind: "sticker" }
  | { kind: "story"; chatId: number; storyId: number }
  | { kind: "video" }
  | { kind: "video_note" }
  | { kind: "voice" }
  | {
      kind: "contact";
      phoneNumber: string;
      firstName: string;
      lastName?: string;
      userId?: number;
      vcard?: string;
    }
  | { kind: "dice"; emoji: string; value: number }
  | { kind: "game"; title: string; description: string; text: string }
  | {
      kind: "poll";
      question: string;
      options: TelegramPollOption[];
      totalVoterCount: number;
      closed: boolean;
      anonymous: boolean;
      pollType: "regular" | "quiz";
      multipleAnswers: boolean;
      allowsRevoting: boolean;
      membersOnly: boolean;
      correctOptionIds?: number[];
      countryCodes?: string[];
      explanation?: string;
      description?: string;
      openPeriod?: number;
      closeDate?: number;
      media?: TelegramPollEmbeddedContent[];
    }
  | {
      kind: "venue";
      latitude: number;
      longitude: number;
      title: string;
      address: string;
      foursquareId?: string;
      foursquareType?: string;
      googlePlaceId?: string;
      googlePlaceType?: string;
    }
  | {
      kind: "location";
      latitude: number;
      longitude: number;
      horizontalAccuracy?: number;
      livePeriod?: number;
      heading?: number;
      proximityAlertRadius?: number;
    }
  | {
      kind: "checklist";
      title: string;
      tasks: TelegramChecklistTask[];
      othersCanAddTasks: boolean;
      othersCanMarkTasksDone: boolean;
    };

export type TelegramMessageContent =
  | TelegramMessageContentData
  | {
      kind: "unavailable";
      contentKind: TelegramContentKind;
      reasons: TelegramContentUnavailableReason[];
    };

export interface AttachmentDownloader {
  download(
    attachment: TelegramAttachment,
    chatId: number,
    messageId: number,
  ): Promise<TelegramAttachment>;
}

export interface TelegramQuote {
  text: string;
}

export interface ReferencedTelegramMessage {
  messageId?: number;
  role: "user" | "assistant";
  sentAt: string;
  text: string;
  content?: TelegramMessageContent;
  mediaGroupId?: string;
  piEntryId?: string;
  forward?: TelegramForwardOrigin;
  attachments: TelegramAttachment[];
}

export interface TelegramReply {
  messageId?: number;
  story?: { chatId: number; storyId: number };
  quote?: TelegramQuote;
  externalSource?: TelegramForwardOrigin;
  target?: ReferencedTelegramMessage;
}

export interface NormalizedTelegramMessage {
  updateId: number;
  chatId: number;
  messageId: number;
  sentAt: string;
  sender: {
    id: number;
    displayName: string;
    username?: string;
  };
  text: string;
  content?: TelegramMessageContent;
  mediaGroupId?: string;
  forward?: TelegramForwardOrigin;
  reply?: TelegramReply;
  attachments: TelegramAttachment[];
}

export interface IndexedTelegramMessage extends ReferencedTelegramMessage {
  messageId: number;
  piSessionId: string;
}
