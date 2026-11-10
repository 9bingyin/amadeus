import { copyJson, type JsonValue } from "@earendil-works/chord/json";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { Message } from "grammy/types";
import { z } from "zod";

export const CONTENT_FIELDS = [
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
] as const satisfies readonly (keyof Message)[];

export type RemoteFile = {
  fileId: string;
  name: string;
  mimeType: string;
  size: number | null;
};

const referenceFields = new Set([
  "reply_to_message",
  "pinned_message",
  "checklist_message",
  "poll_message",
  "suggested_post_message",
  "giveaway_message",
]);
const referenceSchema = z.object({
  message_id: z.number(),
  date: z.number(),
  chat: z.object({ id: z.number(), type: z.string() }),
});

export function snapshotMessage(message: Message): JsonObject {
  // 根值始终是当前 Message 对象；原生 JSON replacer 在任意深度收缩消息引用并断开对象别名。
  const snapshot: JsonObject = JSON.parse(
    JSON.stringify(message, (key, value: unknown) =>
      value != null && referenceFields.has(key)
        ? referenceSchema.parse(value)
        : value,
    ),
  );
  return snapshot;
}

export function messageContent(message: Message): JsonObject {
  const result: JsonObject = {};
  for (const key of CONTENT_FIELDS) {
    const value = message[key];
    if (value !== undefined)
      result[key] = copyJson(value, { omitUndefinedProperties: true });
  }
  return result;
}

export function isCommandMessage(message: Message): boolean {
  return (
    message.entities?.some(
      (entity) => entity.type === "bot_command" && entity.offset === 0,
    ) ?? false
  );
}

const defaults: Record<string, { name: string; mimeType: string }> = {
  photo: { name: "photo.jpg", mimeType: "image/jpeg" },
  animation: { name: "animation.mp4", mimeType: "video/mp4" },
  video: { name: "video.mp4", mimeType: "video/mp4" },
  live_photo: { name: "live-photo.mp4", mimeType: "video/mp4" },
  video_note: { name: "video-note.mp4", mimeType: "video/mp4" },
  voice: { name: "voice.ogg", mimeType: "audio/ogg" },
  voice_note: { name: "voice.ogg", mimeType: "audio/ogg" },
  audio: { name: "audio.mp3", mimeType: "audio/mpeg" },
  sticker: { name: "sticker.webp", mimeType: "image/webp" },
};

function photoArea(value: JsonValue): number {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value["width"] === "number" &&
    typeof value["height"] === "number"
  )
    return value["width"] * value["height"];
  return 0;
}

export function messageFiles(content: JsonObject): RemoteFile[] {
  const files = new Map<string, RemoteFile>();
  function visit(value: JsonValue, field: string): void {
    if (Array.isArray(value)) {
      if (field === "photo") {
        // photo 是同一图片的不同尺寸；只下载最大版本，其他版本的元数据仍保留。
        const largest = value.reduce<JsonValue>(
          (best, item) => (photoArea(item) > photoArea(best) ? item : best),
          null,
        );
        visit(largest, field);
      } else for (const item of value) visit(item, field);
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (typeof value["file_id"] === "string") {
      let fallback = defaults[field] ?? {
        name: "attachment",
        mimeType: "application/octet-stream",
      };
      if (field === "sticker" && value["is_animated"] === true)
        fallback = { name: "sticker.tgs", mimeType: "application/x-tgsticker" };
      else if (field === "sticker" && value["is_video"] === true)
        fallback = { name: "sticker.webm", mimeType: "video/webm" };
      const file: RemoteFile = {
        fileId: value["file_id"],
        name:
          typeof value["file_name"] === "string"
            ? value["file_name"]
            : fallback.name,
        mimeType:
          typeof value["mime_type"] === "string"
            ? value["mime_type"]
            : fallback.mimeType,
        size:
          typeof value["file_size"] === "number" ? value["file_size"] : null,
      };
      files.set(
        typeof value["file_unique_id"] === "string"
          ? value["file_unique_id"]
          : file.fileId,
        file,
      );
      if (field === "live_photo" && value["photo"])
        visit(value["photo"], "photo");
      // 缩略图、封面等派生文件仅保留元数据，不另外当成用户附件下载。
      return;
    }
    for (const [key, item] of Object.entries(value)) visit(item, key);
  }
  visit(content, "");
  return [...files.values()];
}
