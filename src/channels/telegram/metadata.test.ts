import { expect, test } from "bun:test";
import type { Message } from "grammy/types";
import {
  CONTENT_FIELDS,
  messageContent,
  messageFiles,
  snapshotMessage,
} from "./metadata";

const base = {
  message_id: 1,
  date: 1,
  chat: { id: 1, type: "private", first_name: "用户" },
  from: { id: 1, is_bot: false, first_name: "用户" },
} satisfies Message;
function asReply(message: Message): NonNullable<Message["reply_to_message"]> {
  // grammY requires explicit undefined here; Telegram omits the field at runtime.
  return message as NonNullable<Message["reply_to_message"]>;
}
const photo = (id: string, side: number) => ({
  file_id: id,
  file_unique_id: id,
  width: side,
  height: side,
});

test("Preserves current fields and service messages without recursively saving references", () => {
  for (const field of CONTENT_FIELDS) {
    const value = field === "text" ? "正文" : { marker: field };
    const message = { ...base, [field]: value };
    expect(messageContent(message)).toEqual({ [field]: value });
    expect(snapshotMessage(message)).toEqual(message);
  }
  const message = {
    ...base,
    forum_topic_closed: {},
    write_access_allowed: { from_request: true },
    future_service: { values: [true, 12, null, "保留"] },
    pinned_message: { ...base, message_id: 3, text: "不复制其他整条消息" },
    reply_to_message: asReply({
      ...base,
      message_id: 2,
      text: "不复制其他整条消息",
      pinned_message: { ...base, message_id: 4, text: "不递归" },
    }),
  };
  expect(messageContent(message)).toEqual({});
  const snapshot = snapshotMessage(message);
  expect(snapshot).toEqual({
    ...base,
    forum_topic_closed: {},
    write_access_allowed: { from_request: true },
    future_service: { values: [true, 12, null, "保留"] },
    pinned_message: {
      message_id: 3,
      date: 1,
      chat: { id: 1, type: "private" },
    },
    reply_to_message: {
      message_id: 2,
      date: 1,
      chat: { id: 1, type: "private" },
    },
  });
  message.future_service.values.push("变化");
  expect(snapshot["future_service"]).toEqual({
    values: [true, 12, null, "保留"],
  });
});

test("Shrinks nested message references without dropping current-message fields", () => {
  const keys = [
    "reply_to_message",
    "pinned_message",
    "checklist_message",
    "poll_message",
    "suggested_post_message",
    "giveaway_message",
  ];
  const referenced = {
    ...base,
    message_id: 2,
    text: "不复制引用正文",
    photo: [photo("nested", 8)],
  };
  const message = {
    ...base,
    text: "保留当前正文",
    future_service: {
      entries: keys.map((key) => ({
        [key]: referenced,
        detail: "保留本事件字段",
      })),
      absent: { checklist_message: null },
    },
  };
  const snapshot = snapshotMessage(message);
  expect(snapshot).toEqual({
    ...base,
    text: "保留当前正文",
    future_service: {
      entries: keys.map((key) => ({
        [key]: {
          message_id: 2,
          date: 1,
          chat: { id: 1, type: "private" },
        },
        detail: "保留本事件字段",
      })),
      absent: { checklist_message: null },
    },
  });
  expect(JSON.stringify(snapshot)).not.toContain("不复制引用正文");
  expect(referenced.text).toBe("不复制引用正文");
});

test("Finds primary attachments without downloading thumbnails or referenced messages", () => {
  const shared = {
    file_id: "animation",
    file_unique_id: "same",
    width: 8,
    height: 8,
    duration: 1,
    mime_type: "video/mp4",
    thumbnail: photo("thumb", 1),
  };
  const message: Message = {
    ...base,
    photo: [photo("small", 1), photo("large", 10)],
    animation: shared,
    document: { ...shared, file_name: "animation.mp4" },
    live_photo: {
      file_id: "live-video",
      file_unique_id: "live-video",
      width: 8,
      height: 8,
      duration: 1,
      photo: [photo("live-small", 1), photo("live-large", 8)],
    },
    rich_message: {
      blocks: [
        {
          type: "photo",
          photo: [photo("rich-small", 1), photo("rich-large", 8)],
        },
        {
          type: "document",
          document: {
            file_id: "document",
            file_unique_id: "document",
            file_name: "原件.pdf",
            mime_type: "application/pdf",
          },
        },
      ],
    },
    paid_media: {
      star_count: 1,
      paid_media: [
        { type: "preview", width: 4, height: 4 },
        {
          type: "photo",
          photo: [photo("paid-small", 1), photo("paid-large", 8)],
        },
      ],
    },
    reply_to_message: asReply({ ...base, photo: [photo("reply", 8)] }),
  };
  const files = messageFiles(messageContent(message));
  expect(files.map((file) => file.fileId).sort()).toEqual([
    "animation",
    "document",
    "large",
    "live-large",
    "live-video",
    "paid-large",
    "rich-large",
  ]);
  expect(files.find((file) => file.fileId === "document")).toMatchObject({
    name: "原件.pdf",
    mimeType: "application/pdf",
  });
  expect(files.find((file) => file.fileId === "live-video")).toMatchObject({
    name: "live-photo.mp4",
    mimeType: "video/mp4",
  });
});

test("Preserves media download parameters without treating animated stickers as images", () => {
  for (const [field, mimeType] of [
    ["voice", "audio/ogg"],
    ["audio", "audio/mpeg"],
    ["video", "video/mp4"],
    ["video_note", "video/mp4"],
  ]) {
    const files = messageFiles({
      [field ?? ""]: {
        file_id: "file",
        file_unique_id: "unique",
        file_size: 42,
      },
    });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ mimeType, size: 42 });
  }
  for (const flags of [
    { is_animated: false, is_video: false },
    { is_animated: true, is_video: false },
    { is_animated: false, is_video: true },
  ]) {
    const files = messageFiles({
      sticker: { file_id: "sticker", file_unique_id: "sticker", ...flags },
    });
    expect(files[0]?.mimeType).toBe(
      flags.is_animated
        ? "application/x-tgsticker"
        : flags.is_video
          ? "video/webm"
          : "image/webp",
    );
  }
});
