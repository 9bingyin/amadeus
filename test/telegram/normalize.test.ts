import { describe, expect, test } from "bun:test";
import type { Message } from "grammy/types";
import type {
  TelegramAttachmentKind,
  TelegramContentKind,
} from "../../src/telegram/types";
import {
  normalizeTelegramMessage,
  renderTextLinks,
} from "../../src/telegram/normalize";

const privateChat = {
  id: 123456789,
  type: "private",
  first_name: "Example",
} as const;
const sender = {
  id: 123456789,
  is_bot: false,
  first_name: "Example",
  username: "example_user",
} as const;

describe("normalizeTelegramMessage", () => {
  test("选择最大面积图片并保留频道转发来源", () => {
    const message = {
      message_id: 188,
      date: 1788277194,
      chat: privateChat,
      from: sender,
      caption: "截图",
      photo: [
        {
          file_id: "small",
          file_unique_id: "small-u",
          width: 320,
          height: 180,
        },
        {
          file_id: "large",
          file_unique_id: "large-u",
          width: 1280,
          height: 720,
          file_size: 345_678,
        },
      ],
      forward_origin: {
        type: "channel",
        date: 1788271000,
        chat: {
          id: -1001,
          type: "channel",
          title: "示例频道",
          username: "example_channel",
        },
        message_id: 42,
      },
    } satisfies Message;

    const result = normalizeTelegramMessage(10, message);

    expect(result.status).toBe("supported");
    if (result.status !== "supported") {
      throw new Error("预期消息可处理");
    }
    expect(result.message.attachments).toEqual([
      {
        kind: "photo",
        fileId: "large",
        fileUniqueId: "large-u",
        width: 1280,
        height: 720,
        size: 345_678,
      },
    ]);
    expect(result.message.forward).toMatchObject({
      kind: "channel",
      username: "example_channel",
      messageId: 42,
    });
  });

  test("无 caption 图片仍可处理", () => {
    const message = {
      message_id: 189,
      date: 1788277194,
      chat: privateChat,
      from: sender,
      photo: [
        {
          file_id: "photo",
          file_unique_id: "photo-u",
          width: 800,
          height: 600,
        },
      ],
    } satisfies Message;

    const result = normalizeTelegramMessage(13, message);

    expect(result.status).toBe("supported");
    if (result.status !== "supported") {
      throw new Error("预期消息可处理");
    }
    expect(result.message.text).toBe("");
    expect(result.message.attachments[0]?.kind).toBe("photo");
  });

  test("归一化所有媒体内容类型并避免兼容字段重复", () => {
    const animation = {
      file_id: "animation",
      file_unique_id: "animation-u",
      width: 640,
      height: 360,
      duration: 3,
    };
    const cases: Array<{
      kind: TelegramContentKind;
      payload: Partial<Message>;
      attachmentKinds: TelegramAttachmentKind[];
    }> = [
      {
        kind: "animation",
        payload: {
          animation,
          document: {
            file_id: "animation",
            file_unique_id: "animation-u",
          },
        },
        attachmentKinds: ["animation"],
      },
      {
        kind: "audio",
        payload: {
          audio: {
            file_id: "audio",
            file_unique_id: "audio-u",
            duration: 42,
            performer: "Artist",
            title: "Song",
          },
        },
        attachmentKinds: ["audio"],
      },
      {
        kind: "document",
        payload: {
          document: {
            file_id: "document",
            file_unique_id: "document-u",
          },
        },
        attachmentKinds: ["document"],
      },
      {
        kind: "live_photo",
        payload: {
          live_photo: {
            file_id: "live",
            file_unique_id: "live-u",
            width: 1080,
            height: 1920,
            duration: 3,
            photo: [
              {
                file_id: "live-static",
                file_unique_id: "live-static-u",
                width: 1080,
                height: 1920,
              },
            ],
          },
          photo: [
            {
              file_id: "compat-static",
              file_unique_id: "compat-static-u",
              width: 320,
              height: 480,
            },
          ],
        },
        attachmentKinds: ["photo", "live_photo"],
      },
      {
        kind: "paid_media",
        payload: {
          paid_media: {
            star_count: 10,
            paid_media: [
              { type: "preview", width: 640, height: 360, duration: 5 },
              {
                type: "photo",
                photo: [
                  {
                    file_id: "paid-photo",
                    file_unique_id: "paid-photo-u",
                    width: 800,
                    height: 600,
                  },
                ],
              },
              {
                type: "video",
                video: {
                  file_id: "paid-video",
                  file_unique_id: "paid-video-u",
                  width: 1280,
                  height: 720,
                  duration: 20,
                },
              },
            ],
          },
        },
        attachmentKinds: ["photo", "video"],
      },
      {
        kind: "photo",
        payload: {
          photo: [
            {
              file_id: "photo",
              file_unique_id: "photo-u",
              width: 800,
              height: 600,
            },
          ],
        },
        attachmentKinds: ["photo"],
      },
      {
        kind: "sticker",
        payload: {
          sticker: {
            file_id: "sticker",
            file_unique_id: "sticker-u",
            type: "regular",
            width: 512,
            height: 512,
            is_animated: false,
            is_video: false,
            emoji: "x",
          },
        },
        attachmentKinds: ["sticker"],
      },
      {
        kind: "story",
        payload: { story: { chat: privateChat, id: 7 } },
        attachmentKinds: [],
      },
      {
        kind: "video",
        payload: {
          video: {
            file_id: "video",
            file_unique_id: "video-u",
            width: 1920,
            height: 1080,
            duration: 30,
          },
        },
        attachmentKinds: ["video"],
      },
      {
        kind: "video_note",
        payload: {
          video_note: {
            file_id: "video-note",
            file_unique_id: "video-note-u",
            length: 384,
            duration: 15,
          },
        },
        attachmentKinds: ["video_note"],
      },
      {
        kind: "voice",
        payload: {
          voice: {
            file_id: "voice",
            file_unique_id: "voice-u",
            duration: 8,
            mime_type: "audio/ogg",
          },
        },
        attachmentKinds: ["voice"],
      },
    ];

    for (const [index, item] of cases.entries()) {
      const result = normalizeTelegramMessage(100 + index, {
        message_id: 200 + index,
        date: 1788277194,
        chat: privateChat,
        from: sender,
        ...item.payload,
      } as Message);
      expect(result.status).toBe("supported");
      if (result.status !== "supported") {
        throw new Error(`预期 ${item.kind} 可处理`);
      }
      expect(result.message.content?.kind).toBe(item.kind);
      expect(result.message.attachments.map(({ kind }) => kind)).toEqual(
        item.attachmentKinds,
      );
      if (item.kind === "paid_media") {
        expect(result.message.content).toMatchObject({
          starCount: 10,
          itemCount: 3,
          unavailableItemCount: 1,
          previews: [{ index: 0, width: 640, height: 360, duration: 5 }],
        });
        expect(result.message.attachments).toMatchObject([
          { source: "paid_media", sourceIndex: 1 },
          { source: "paid_media", sourceIndex: 2 },
        ]);
      }
    }
  });

  test("归一化全部结构化内容消息", () => {
    const gameAnimation = {
      file_id: "game-animation",
      file_unique_id: "game-animation-u",
      width: 640,
      height: 360,
      duration: 3,
    };
    const cases: Array<{
      kind: TelegramContentKind;
      payload: Partial<Message>;
    }> = [
      {
        kind: "contact",
        payload: {
          contact: {
            phone_number: "+123456",
            first_name: "Ada",
            last_name: "Lovelace",
            user_id: 42,
            vcard: "BEGIN:VCARD\nEND:VCARD",
          },
        },
      },
      { kind: "dice", payload: { dice: { emoji: "dice", value: 6 } } },
      {
        kind: "game",
        payload: {
          game: {
            title: "Game",
            description: "Description",
            photo: [
              {
                file_id: "game-photo",
                file_unique_id: "game-photo-u",
                width: 800,
                height: 600,
              },
            ],
            text: "Play here",
            text_entities: [],
            animation: gameAnimation,
          },
        },
      },
      {
        kind: "poll",
        payload: {
          poll: {
            id: "opaque-poll-id",
            question: "Choose",
            options: [
              {
                persistent_id: "opaque-option-id-0",
                text: "One",
                voter_count: 1,
              },
              {
                persistent_id: "opaque-option-id-1",
                text: "Two",
                voter_count: 1,
                media: {
                  photo: [
                    {
                      file_id: "poll-photo",
                      file_unique_id: "poll-photo-u",
                      width: 640,
                      height: 480,
                    },
                  ],
                },
              },
              {
                persistent_id: "opaque-option-id-2",
                text: "Three",
                voter_count: 0,
                media: {
                  venue: {
                    location: { latitude: 40.7, longitude: -74 },
                    title: "Venue",
                    address: "Address",
                  },
                },
              },
            ],
            total_voter_count: 2,
            is_closed: false,
            is_anonymous: true,
            type: "quiz",
            allows_multiple_answers: false,
            allows_revoting: true,
            members_only: false,
            correct_option_ids: [0],
            explanation: "Because",
            open_period: 60,
            close_date: 1_788_280_000,
            media: { link: { url: "https://example.com/poll" } },
            explanation_media: {
              location: {
                latitude: 31.2,
                longitude: 121.5,
                horizontal_accuracy: 5,
              },
            },
          },
        },
      },
      {
        kind: "venue",
        payload: {
          venue: {
            location: { latitude: 31.2, longitude: 121.5 },
            title: "Office",
            address: "Road 1",
            foursquare_id: "foursquare",
            foursquare_type: "office",
            google_place_id: "google",
            google_place_type: "work",
          },
          location: { latitude: 0, longitude: 0 },
        },
      },
      {
        kind: "location",
        payload: {
          location: {
            latitude: 31.2,
            longitude: 121.5,
            horizontal_accuracy: 5,
            live_period: 60,
            heading: 90,
            proximity_alert_radius: 100,
          },
        },
      },
      {
        kind: "checklist",
        payload: {
          checklist: {
            title: "Release",
            tasks: [
              {
                id: 1,
                text: "Test",
                completion_date: 1,
                completed_by_user: sender,
                completed_by_chat: privateChat,
              },
              { id: 2, text: "Deploy", completion_date: 0 },
            ],
            others_can_add_tasks: true,
          },
        },
      },
    ];

    for (const [index, item] of cases.entries()) {
      const result = normalizeTelegramMessage(300 + index, {
        message_id: 400 + index,
        date: 1788277194,
        chat: privateChat,
        from: sender,
        ...item.payload,
      } as Message);
      expect(result.status).toBe("supported");
      if (result.status !== "supported") {
        throw new Error(`预期 ${item.kind} 可处理`);
      }
      expect(result.message.content?.kind).toBe(item.kind);
      if (item.kind === "game") {
        expect(result.message.attachments.map(({ kind }) => kind)).toEqual([
          "photo",
          "animation",
        ]);
      }
      if (item.kind === "poll") {
        expect(result.message.content).toMatchObject({
          correctOptionIds: [0],
          allowsRevoting: true,
          openPeriod: 60,
          closeDate: 1_788_280_000,
          media: [
            {
              kind: "link",
              section: "description",
              url: "https://example.com/poll",
            },
            {
              kind: "location",
              section: "explanation",
              latitude: 31.2,
              longitude: 121.5,
              horizontalAccuracy: 5,
            },
            {
              kind: "venue",
              section: "option",
              optionIndex: 2,
              title: "Venue",
            },
          ],
        });
        expect(result.message.content).not.toHaveProperty("id");
        expect(result.message.attachments).toMatchObject([
          {
            kind: "photo",
            source: "poll",
            sourceSection: "option",
            sourceIndex: 1,
          },
        ]);
      }
      if (item.kind === "venue") {
        expect(result.message.content).toMatchObject({
          latitude: 31.2,
          longitude: 121.5,
        });
      }
      if (item.kind === "checklist") {
        expect(result.message.content).toMatchObject({
          tasks: [
            {
              id: 1,
              completed: true,
              completionDate: 1,
              completedByUserId: sender.id,
              completedByChatId: privateChat.id,
            },
            { id: 2, completed: false },
          ],
        });
      }
    }
  });

  test("渲染 rich message 并提取嵌套媒体，但不泄露 callback data", () => {
    const result = normalizeTelegramMessage(500, {
      message_id: 501,
      date: 1788277194,
      chat: privateChat,
      from: sender,
      rich_message: {
        blocks: [
          { type: "heading", size: 2, text: "Report" },
          {
            type: "paragraph",
            text: [
              "See ",
              {
                type: "url",
                text: "source",
                url: "https://example.com/report",
              },
            ],
          },
          {
            type: "collage",
            blocks: [
              {
                type: "photo",
                photo: [
                  {
                    file_id: "rich-photo",
                    file_unique_id: "rich-photo-u",
                    width: 1280,
                    height: 720,
                  },
                ],
                caption: { text: "Screenshot" },
              },
            ],
          },
          {
            type: "buttons",
            buttons: [{ text: "Run", callback_data: "secret-callback" }],
          },
        ],
      },
    } as Message);

    expect(result.status).toBe("supported");
    if (result.status !== "supported") {
      throw new Error("预期 rich message 可处理");
    }
    expect(result.message.text).toContain("## Report");
    expect(result.message.text).toContain(
      "source (https://example.com/report)",
    );
    expect(result.message.text).toContain("Screenshot");
    expect(result.message.text).not.toContain("secret-callback");
    expect(result.message.content).toEqual({
      kind: "rich_message",
      blockTypes: ["heading", "paragraph", "collage", "photo", "buttons"],
    });
    expect(result.message.attachments).toMatchObject([
      { kind: "photo", source: "rich_message", sourceIndex: 0 },
    ]);
  });

  test("未知 paid media 和 rich block 产生结构化不可用结果", () => {
    const paid = normalizeTelegramMessage(700, {
      message_id: 701,
      date: 1788277194,
      chat: privateChat,
      from: sender,
      paid_media: {
        star_count: 1,
        paid_media: [{ type: "future_media" }],
      },
    } as unknown as Message);
    expect(paid.status).toBe("supported");
    if (paid.status !== "supported") {
      throw new Error("预期未知 paid media 安全处理");
    }
    expect(paid.message.content).toEqual({
      kind: "paid_media",
      starCount: 1,
      itemCount: 1,
      unavailableItemCount: 1,
      unavailableReasons: ["unsupported_nested_type"],
    });
    expect(paid.message.attachments).toEqual([]);

    const rich = normalizeTelegramMessage(702, {
      message_id: 703,
      date: 1788277194,
      chat: privateChat,
      from: sender,
      rich_message: { blocks: [{ type: "future_block" }] },
    } as unknown as Message);
    expect(rich.status).toBe("supported");
    if (rich.status !== "supported") {
      throw new Error("预期未知 rich block 安全处理");
    }
    expect(rich.message.text).toBe("[unsupported rich block]");
    expect(rich.message.content).toEqual({
      kind: "rich_message",
      blockTypes: ["future_block"],
      unavailableBlockCount: 1,
      unavailableReasons: ["unsupported_nested_type", "missing_fields"],
    });

    const richText = normalizeTelegramMessage(704, {
      message_id: 705,
      date: 1788277194,
      chat: privateChat,
      from: sender,
      rich_message: {
        blocks: [
          {
            type: "paragraph",
            text: { type: "future_text", value: "x" },
          },
        ],
      },
    } as unknown as Message);
    expect(richText.status).toBe("supported");
    if (richText.status !== "supported") {
      throw new Error("预期未知 rich text 安全处理");
    }
    expect(richText.message.text).toBe("[unsupported rich text]");
    expect(richText.message.content).toMatchObject({
      kind: "rich_message",
      unavailableBlockCount: 1,
      unavailableReasons: ["unsupported_nested_type", "missing_fields"],
    });
  });

  test("缺失必需字段时生成 unavailable 内容而不伪装成已读取", () => {
    const cases: Array<{
      contentKind: TelegramContentKind;
      payload: Record<string, unknown>;
    }> = [
      { contentKind: "photo", payload: { photo: [], caption: "保留 caption" } },
      { contentKind: "document", payload: { document: {} } },
      {
        contentKind: "rich_message",
        payload: { rich_message: { blocks: [] } },
      },
      {
        contentKind: "contact",
        payload: { contact: { phone_number: "+123" } },
      },
      {
        contentKind: "paid_media",
        payload: { paid_media: { star_count: 1, paid_media: [] } },
      },
    ];

    for (const [index, item] of cases.entries()) {
      const result = normalizeTelegramMessage(800 + index, {
        message_id: 810 + index,
        date: 1788277194,
        chat: privateChat,
        from: sender,
        ...item.payload,
      } as unknown as Message);
      expect(result.status).toBe("supported");
      if (result.status !== "supported") {
        throw new Error(`预期缺失字段的 ${item.contentKind} 安全处理`);
      }
      expect(result.message.content).toEqual({
        kind: "unavailable",
        contentKind: item.contentKind,
        reasons: ["missing_fields"],
      });
      expect(result.message.attachments).toEqual([]);
      if (item.contentKind === "photo") {
        expect(result.message.text).toBe("保留 caption");
      }
    }
  });

  test("缺失的 paid media 和 rich media 嵌套字段明确标记 unavailable", () => {
    const paid = normalizeTelegramMessage(850, {
      message_id: 851,
      date: 1788277194,
      chat: privateChat,
      from: sender,
      paid_media: {
        star_count: 1,
        paid_media: [{ type: "photo", photo: [] }],
      },
    } as Message);
    expect(paid.status).toBe("supported");
    if (paid.status !== "supported") {
      throw new Error("预期空 paid photo 安全处理");
    }
    expect(paid.message.content).toMatchObject({
      kind: "paid_media",
      unavailableItemCount: 1,
      unavailableReasons: ["missing_fields"],
    });
    expect(paid.message.attachments).toEqual([]);

    const rich = normalizeTelegramMessage(852, {
      message_id: 853,
      date: 1788277194,
      chat: privateChat,
      from: sender,
      rich_message: { blocks: [{ type: "photo", photo: [] }] },
    } as Message);
    expect(rich.status).toBe("supported");
    if (rich.status !== "supported") {
      throw new Error("预期空 rich photo 安全处理");
    }
    expect(rich.message.content).toMatchObject({
      kind: "rich_message",
      unavailableBlockCount: 1,
      unavailableReasons: ["unsupported_nested_type", "missing_fields"],
    });
    expect(rich.message.attachments).toEqual([]);
  });

  test("转发文字保留原始来源和时间", () => {
    const message = {
      message_id: 190,
      date: 1788277194,
      chat: privateChat,
      from: sender,
      text: "转发正文",
      forward_origin: {
        type: "hidden_user",
        date: 1788271000,
        sender_user_name: "Hidden Author",
      },
    } satisfies Message;

    const result = normalizeTelegramMessage(14, message);

    expect(result.status).toBe("supported");
    if (result.status !== "supported") {
      throw new Error("预期消息可处理");
    }
    expect(result.message.forward).toEqual({
      kind: "hidden_user",
      displayName: "Hidden Author",
      sentAt: "2026-09-01T13:56:40Z",
    });
  });

  test("保留 reply、手动 quote 和被引用消息附件", () => {
    const message = {
      message_id: 191,
      date: 1788279056,
      chat: privateChat,
      from: sender,
      text: "test",
      quote: {
        text: "这是一段用于测试的引用文本",
        position: 37,
        is_manual: true,
      },
      reply_to_message: {
        message_id: 189,
        date: 1788277739,
        reply_to_message: undefined,
        chat: privateChat,
        from: sender,
        caption: "原消息正文",
        photo: [
          {
            file_id: "photo",
            file_unique_id: "photo-u",
            width: 868,
            height: 488,
          },
        ],
        forward_origin: {
          type: "channel",
          date: 1788271000,
          chat: {
            id: -1001,
            type: "channel",
            title: "示例频道",
            username: "example_channel",
          },
          message_id: 42,
        },
      },
    };

    const result = normalizeTelegramMessage(11, message as unknown as Message);

    expect(result.status).toBe("supported");
    if (result.status !== "supported") {
      throw new Error("预期消息可处理");
    }
    expect(result.message.reply?.messageId).toBe(189);
    expect(result.message.reply?.quote?.text).toBe(
      "这是一段用于测试的引用文本",
    );
    expect(result.message.reply?.target?.text).toBe("原消息正文");
    expect(result.message.reply?.target?.attachments[0]?.kind).toBe("photo");
  });

  test("保留 reply_to_story 关系和不可用内容状态", () => {
    const result = normalizeTelegramMessage(590, {
      message_id: 591,
      date: 1788277194,
      chat: privateChat,
      from: sender,
      text: "回复故事",
      reply_to_story: { chat: privateChat, id: 9 },
    } as Message);

    expect(result.status).toBe("supported");
    if (result.status !== "supported") {
      throw new Error("预期 story reply 可处理");
    }
    expect(result.message.reply?.story).toEqual({
      chatId: 123456789,
      storyId: 9,
    });
    expect(result.message.reply?.target?.content).toEqual({
      kind: "story",
      chatId: 123456789,
      storyId: 9,
    });
  });

  test("external reply 保留结构化内容和媒体", () => {
    const result = normalizeTelegramMessage(600, {
      message_id: 601,
      date: 1788277194,
      chat: privateChat,
      from: sender,
      text: "继续",
      quote: { text: "Ada", position: 0 },
      external_reply: {
        origin: {
          type: "hidden_user",
          date: 1788271000,
          sender_user_name: "External",
        },
        message_id: 77,
        contact: {
          phone_number: "+123456",
          first_name: "Ada",
        },
      },
    } as Message);

    expect(result.status).toBe("supported");
    if (result.status !== "supported") {
      throw new Error("预期 external reply 可处理");
    }
    expect(result.message.reply?.externalSource).toMatchObject({
      kind: "hidden_user",
      displayName: "External",
    });
    expect(result.message.reply?.target?.content).toEqual({
      kind: "contact",
      phoneNumber: "+123456",
      firstName: "Ada",
    });
    expect(result.message.reply?.target?.text).toBe("Ada");
  });

  test("external reply 缺失附件字段时保留 unavailable 引用", () => {
    const result = normalizeTelegramMessage(610, {
      message_id: 611,
      date: 1788277194,
      chat: privateChat,
      from: sender,
      text: "继续",
      external_reply: {
        origin: {
          type: "hidden_user",
          date: 1788271000,
          sender_user_name: "External",
        },
        message_id: 77,
        document: {},
      },
    } as unknown as Message);

    expect(result.status).toBe("supported");
    if (result.status !== "supported") {
      throw new Error("预期 external reply 缺失字段安全处理");
    }
    expect(result.message.reply?.target?.content).toEqual({
      kind: "unavailable",
      contentKind: "document",
      reasons: ["missing_fields"],
    });
    expect(result.message.reply?.target?.attachments).toEqual([]);
  });

  test("保留 document 文件信息", () => {
    const message = {
      message_id: 190,
      date: 1788278000,
      chat: privateChat,
      from: sender,
      document: {
        file_id: "exe",
        file_unique_id: "exe-u",
        file_name: "rustdesk-1.4.9-x86_64.exe",
        mime_type: "application/octet-stream",
        file_size: 24_472_432,
      },
    } satisfies Message;

    const result = normalizeTelegramMessage(12, message);

    expect(result.status).toBe("supported");
    if (result.status !== "supported") {
      throw new Error("预期消息可处理");
    }
    expect(result.message.attachments[0]).toMatchObject({
      kind: "document",
      fileName: "rustdesk-1.4.9-x86_64.exe",
      size: 24_472_432,
    });
  });

  test("将隐藏链接目标补到正文", () => {
    expect(
      renderTextLinks("查看来源", [
        {
          type: "text_link",
          offset: 0,
          length: 4,
          url: "https://example.com/report",
        },
      ]),
    ).toBe("查看来源 (https://example.com/report)");
  });
});
