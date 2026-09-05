import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramDownloadError } from "../../src/telegram/download";
import type { NormalizedTelegramMessage } from "../../src/telegram/types";
import { compilePiPrompt } from "../../src/bridge/prompt-compiler";
import type { VoiceTranscription } from "../../src/stt/result";
import {
  StateStore,
  indexMessage,
  getOrCreateChatState,
  type ChatState,
} from "../../src/state";

const temporaryDirectories: string[] = [];
const emptyChat: ChatState = { messageOrder: [], messages: {} };

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("compilePiPrompt", () => {
  test("消息索引淘汰后按目标消息和文件身份恢复缓存转录，不重新转录", async () => {
    const root = await mkdtemp(join(tmpdir(), "amadeus-voice-cache-reply-"));
    temporaryDirectories.push(root);
    const path = join(root, "voice.ogg");
    await writeFile(path, "synthetic-audio");
    const results: VoiceTranscription[] = [
      {
        provider: "openrouter",
        model: "microsoft/mai-transcribe-2",
        status: "completed",
        text: "缓存的合成转录",
      },
      {
        provider: "openrouter",
        model: "microsoft/mai-transcribe-2",
        status: "unavailable",
        code: "request_failed",
      },
    ];
    for (const result of results) {
      const chat: ChatState = {
        messageOrder: [],
        messages: {},
        voiceTranscriptions: { "10": { fileUniqueId: "voice-unique", result } },
      };
      for (const fileUniqueId of ["voice-unique", "different-file"]) {
        const message = replyMessage(11);
        message.reply = {
          messageId: 10,
          target: {
            messageId: 10,
            role: "user",
            sentAt: message.sentAt,
            text: "",
            content: { kind: "voice" },
            attachments: [
              { kind: "voice", fileId: "voice-id", fileUniqueId, duration: 1 },
            ],
          },
        };
        const compiled = await compilePiPrompt(message, "new-session", chat, {
          download: async (attachment) => ({ ...attachment, localPath: path }),
        });
        expect(compiled.message).toContain(`path="${path}"`);
        if (fileUniqueId !== "voice-unique")
          expect(compiled.message).not.toContain("<transcription");
        else {
          expect(compiled.message).toContain(`status="${result.status}"`);
          expect(compiled.message).toContain('source="telegram_voice"');
          if (result.status === "completed")
            expect(compiled.message).toContain(result.text);
          else expect(compiled.message).toContain('reason="request_failed"');
        }
      }
    }
  });
  test("语音转录和原文件路径进入 prompt，重启后跨 session 引用仍可读取", async () => {
    const root = await mkdtemp(join(tmpdir(), "amadeus-voice-prompt-"));
    temporaryDirectories.push(root);
    const path = join(root, "voice.ogg");
    await writeFile(path, "synthetic-audio");
    const message = baseMessage(10);
    message.text = "";
    message.content = { kind: "voice" };
    message.attachments = [
      {
        kind: "voice",
        fileId: "voice-id",
        fileUniqueId: "voice-unique",
        mimeType: "audio/ogg",
        localPath: path,
        duration: 3,
        transcription: {
          provider: "openrouter",
          model: "microsoft/mai-transcribe-2",
          status: "completed",
          text: "合成 <语音> & 文本",
        },
      },
    ];
    const downloader = {
      download: async () => {
        throw new Error("must use original attachment");
      },
    };
    const compiled = await compilePiPrompt(
      message,
      "old-session",
      emptyChat,
      downloader,
    );
    expect(compiled.message).toContain('source="telegram_voice"');
    expect(compiled.message).toContain('method="speech_to_text"');
    expect(compiled.message).toContain('model="microsoft/mai-transcribe-2"');
    expect(compiled.message).toContain('mime="audio/ogg"');
    expect(compiled.message).toContain('duration="3"');
    expect(compiled.message).toContain(`path="${path}"`);
    expect(compiled.message).toContain("合成 &lt;语音&gt; &amp; 文本");
    const statePath = join(root, "state.json");
    const store = await StateStore.open(statePath);
    await store.update((state) =>
      indexMessage(getOrCreateChatState(state, 1), compiled.indexedMessage),
    );
    const restored = await StateStore.open(statePath);
    const chat = restored.snapshot().chats["1"];
    if (!chat) throw new Error("missing fixture chat");
    const replying = replyMessage(11);
    replying.reply = {
      messageId: 10,
      target: {
        messageId: 10,
        role: "user",
        sentAt: message.sentAt,
        text: "",
        content: { kind: "voice" },
        attachments: [
          {
            kind: "voice",
            fileId: "voice-id",
            fileUniqueId: "voice-unique",
            duration: 3,
            mimeType: "audio/ogg",
          },
        ],
      },
    };
    const reply = await compilePiPrompt(
      replying,
      "new-session",
      chat,
      downloader,
    );
    expect(reply.message).toContain('<ref role="user" id="10"');
    expect(reply.message).toContain('source="telegram_voice"');
    expect(reply.message).toContain(`path="${path}"`);
    expect(reply.message).toContain("合成 &lt;语音&gt; &amp; 文本");
    await rm(path);
    const replacement = join(root, "downloaded.ogg");
    await writeFile(replacement, "synthetic-redownload");
    const refreshed = await compilePiPrompt(replying, "new-session", chat, {
      download: async (attachment) => ({
        ...attachment,
        localPath: replacement,
      }),
    });
    expect(refreshed.message).toContain(`path="${replacement}"`);
    expect(refreshed.message).toContain("合成 &lt;语音&gt; &amp; 文本");
  });
  test("当前 session 已知引用只发送 reply ID 和 quote", async () => {
    const chat: ChatState = {
      messageOrder: [10],
      messages: {
        "10": {
          messageId: 10,
          role: "user",
          piSessionId: "session-1",
          sentAt: "2026-09-01T00:00:00Z",
          text: "旧回复",
          attachments: [],
        },
      },
    };
    const compiled = await compilePiPrompt(
      replyMessage(11),
      "session-1",
      chat,
      { download: async (attachment) => attachment },
    );

    expect(compiled.message).toContain('by="User (1)"');
    expect(compiled.message).toContain('reply="10"');
    expect(compiled.message).toContain("<q>选区</q>");
    expect(compiled.message).not.toContain("<ref");
  });

  test("当前 session 的 bot 回复引用只发送 Telegram ID 和 Pi entry ID", async () => {
    const assistantText = "这是目标段落 ".repeat(40);
    const chat: ChatState = {
      messageOrder: [10],
      messages: {
        "10": {
          messageId: 10,
          role: "assistant",
          piSessionId: "session-1",
          sentAt: "2026-09-01T00:00:00Z",
          text: assistantText,
          piEntryId: "assistant-entry-1",
          attachments: [],
        },
      },
    };
    const message = baseMessage(11);
    message.reply = { messageId: 10 };

    const compiled = await compilePiPrompt(message, "session-1", chat, {
      download: async (attachment) => attachment,
    });

    expect(compiled.message).toContain(
      '<ref role="assistant" id="10" entry="assistant-entry-1"/>',
    );
    expect(compiled.message).not.toContain(assistantText);
  });

  test("当前 session 的普通 reply 不需要 quote 也能保留关系", async () => {
    const chat: ChatState = {
      messageOrder: [10],
      messages: {
        "10": {
          messageId: 10,
          role: "user",
          piSessionId: "session-1",
          sentAt: "2026-09-01T00:00:00Z",
          text: "用户原文",
          attachments: [],
        },
      },
    };
    const message = baseMessage(11);
    message.reply = { messageId: 10 };

    const compiled = await compilePiPrompt(message, "session-1", chat, {
      download: async (attachment) => attachment,
    });

    expect(compiled.message).toContain('reply="10"');
    expect(compiled.message).not.toContain("<q>");
    expect(compiled.message).not.toContain("<ref");
  });

  test("引用目标不存在时明确失败，不把 reply 静默降级为普通消息", async () => {
    const message = baseMessage(11);
    message.reply = { messageId: 999 };

    const operation = compilePiPrompt(message, "session", emptyChat, {
      download: async (attachment) => attachment,
    });

    await expect(operation).rejects.toThrow("无法解析 Telegram reply 目标 999");
  });

  test("新 session 回复旧索引消息时补充旧消息正文", async () => {
    const chat: ChatState = {
      messageOrder: [10],
      messages: {
        "10": {
          messageId: 10,
          role: "assistant",
          piSessionId: "old-session",
          sentAt: "2026-08-31T00:00:00Z",
          text: "旧 session 的回答",
          attachments: [],
        },
      },
    };

    const compiled = await compilePiPrompt(
      replyMessage(11),
      "new-session",
      chat,
      {
        download: async (attachment) => attachment,
      },
    );

    expect(compiled.message).toContain(
      '<ref role="assistant" id="10">旧 session 的回答</ref>',
    );
  });

  test("reply_to_story 保留专用关系和不可用原因", async () => {
    const message = baseMessage(12);
    message.reply = {
      story: { chatId: 7, storyId: 9 },
      target: {
        role: "user",
        sentAt: "2026-09-01T00:00:00Z",
        text: "",
        content: { kind: "story", chatId: 7, storyId: 9 },
        attachments: [],
      },
    };

    const compiled = await compilePiPrompt(message, "session", emptyChat, {
      download: async (attachment) => attachment,
    });

    expect(compiled.message).toContain('reply_story_chat="7" reply_story="9"');
    expect(compiled.message).toContain(
      '<content kind="story" chat="7" story="9" status="unavailable" reason="content_unavailable"/>',
    );
  });

  test("新 session 引用仅含结构化内容的旧消息", async () => {
    const chat: ChatState = {
      messageOrder: [10],
      messages: {
        "10": {
          messageId: 10,
          role: "user",
          piSessionId: "old-session",
          sentAt: "2026-08-31T00:00:00Z",
          text: "",
          content: { kind: "story", chatId: 7, storyId: 9 },
          attachments: [],
        },
      },
    };

    const compiled = await compilePiPrompt(
      replyMessage(11),
      "new-session",
      chat,
      { download: async (attachment) => attachment },
    );

    expect(compiled.message).toContain(
      '<ref role="user" id="10"><content kind="story" chat="7" story="9" status="unavailable" reason="content_unavailable"/></ref>',
    );
  });

  test("旧 session 引用补充正文和 document 的受控路径", async () => {
    const message = replyMessage(11);
    message.reply = {
      messageId: 10,
      target: {
        messageId: 10,
        role: "user",
        sentAt: "2026-08-31T00:00:00Z",
        text: "旧正文 <x>",
        attachments: [
          {
            kind: "document",
            fileId: "doc",
            fileUniqueId: "doc-u",
            fileName: "report.pdf",
            mimeType: "application/pdf",
            size: 100,
          },
        ],
      },
    };
    const compiled = await compilePiPrompt(message, "new-session", emptyChat, {
      download: async (attachment) => ({
        ...attachment,
        localPath: "/safe/report.pdf",
      }),
    });

    expect(compiled.message).toContain("<text>旧正文 &lt;x&gt;</text>");
    expect(compiled.message).toContain(
      '<file kind="document" name="report.pdf" status="available" path="/safe/report.pdf" mime="application/pdf" size="100"/>',
    );
  });

  test("未知引用附件下载失败时把不可用原因交给 Agent", async () => {
    const message = replyMessage(11);
    message.reply = {
      messageId: 10,
      target: {
        messageId: 10,
        role: "user",
        sentAt: "2026-08-31T00:00:00Z",
        text: "引用附件",
        attachments: [
          {
            kind: "document",
            fileId: "large",
            fileUniqueId: "large-u",
            fileName: "large.bin",
          },
        ],
      },
    };

    const compiled = await compilePiPrompt(message, "new-session", emptyChat, {
      download: async () => {
        throw new TelegramDownloadError("too_large", "file is too big");
      },
    });

    expect(compiled.message).toContain(
      '<file kind="document" name="large.bin" status="unavailable" reason="telegram_public_api_limit" limit="20971520"/>',
    );
  });

  test("引用视频下载失败时仍把原因交给 Agent", async () => {
    const message = replyMessage(11);
    message.reply = {
      messageId: 10,
      target: {
        messageId: 10,
        role: "user",
        sentAt: "2026-08-31T00:00:00Z",
        text: "",
        content: { kind: "video" },
        attachments: [
          {
            kind: "video",
            fileId: "video",
            fileUniqueId: "video-u",
            width: 1920,
            height: 1080,
            duration: 30,
          },
        ],
      },
    };

    const compiled = await compilePiPrompt(message, "new-session", emptyChat, {
      download: async () => {
        throw new Error("offline");
      },
    });

    expect(compiled.message).toContain(
      '<file kind="video" name="video-u" status="unavailable" reason="download_failed" width="1920" height="1080" duration="30"/>',
    );
  });

  test("失效的持久引用路径会重下载，失败时改为 unavailable", async () => {
    const message = replyMessage(11);
    message.reply = {
      messageId: 10,
      target: {
        messageId: 10,
        role: "user",
        sentAt: "2026-08-31T00:00:00Z",
        text: "旧附件",
        content: { kind: "document" },
        attachments: [
          {
            kind: "document",
            fileId: "document",
            fileUniqueId: "document-u",
            fileName: "report.pdf",
            mimeType: "application/pdf",
            localPath: "/missing/report.pdf",
          },
        ],
      },
    };
    let downloadCalls = 0;

    const compiled = await compilePiPrompt(message, "new-session", emptyChat, {
      download: async () => {
        downloadCalls += 1;
        throw new Error("offline");
      },
    });

    expect(downloadCalls).toBe(1);
    expect(compiled.message).toContain(
      '<file kind="document" name="report.pdf" status="unavailable" reason="download_failed" mime="application/pdf"/>',
    );
    expect(compiled.message).not.toContain("/missing/report.pdf");
  });

  test("持久附件的实际文件超限时不再信任旧 localPath", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-prompt-"));
    temporaryDirectories.push(directory);
    const localPath = join(directory, "oversized.bin");
    await writeFile(localPath, "");
    await truncate(localPath, 20 * 1024 * 1024 + 1);
    const message = baseMessage(12);
    message.attachments = [
      {
        kind: "document",
        fileId: "oversized",
        fileUniqueId: "oversized-u",
        fileName: "oversized.bin",
        mimeType: "application/octet-stream",
        localPath,
      },
    ];
    let downloadCalls = 0;

    const compiled = await compilePiPrompt(message, "session", emptyChat, {
      download: async (attachment) => {
        downloadCalls += 1;
        return attachment;
      },
    });

    expect(downloadCalls).toBe(0);
    expect(compiled.message).toContain(
      '<file kind="document" name="oversized.bin" status="unavailable" reason="telegram_public_api_limit" limit="20971520" mime="application/octet-stream"/>',
    );
    expect(compiled.message).not.toContain(localPath);
  });

  test("图片本机读取失败不会中断 Pi 输入", async () => {
    const message = baseMessage(12);
    message.content = { kind: "photo" };
    message.attachments = [
      {
        kind: "photo",
        fileId: "photo",
        fileUniqueId: "photo-u",
        width: 100,
        height: 100,
      },
    ];

    const compiled = await compilePiPrompt(message, "session", emptyChat, {
      download: async (attachment) => ({
        ...attachment,
        localPath: "/missing/image.jpg",
        mimeType: "image/jpeg",
        size: 10,
      }),
    });

    expect(compiled.images).toEqual([]);
    expect(compiled.message).toContain(
      '<file kind="photo" name="photo-u.jpg" status="unavailable" reason="download_failed" mime="image/jpeg" size="10" width="100" height="100"/>',
    );
    expect(compiled.indexedMessage.attachments[0]).toMatchObject({
      unavailableReason: "download_failed",
    });
  });

  test("图片通过 RPC images 传输 base64", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-prompt-"));
    temporaryDirectories.push(directory);
    const imagePath = join(directory, "image.jpg");
    await writeFile(imagePath, "image-bytes");
    const message = baseMessage(12);
    message.attachments = [
      {
        kind: "photo",
        fileId: "photo",
        fileUniqueId: "photo-u",
        width: 100,
        height: 100,
        localPath: imagePath,
      },
    ];

    const compiled = await compilePiPrompt(message, "session", emptyChat, {
      download: async (attachment) => attachment,
    });

    expect(compiled.images).toEqual([
      {
        type: "image",
        data: Buffer.from("image-bytes").toString("base64"),
        mimeType: "image/jpeg",
      },
    ]);
    expect(compiled.message).toContain(
      `kind="photo" name="photo-u.jpg" status="available" path="${imagePath}" mime="image/jpeg"`,
    );
  });

  test("静态 sticker 通过 RPC images 传输", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-prompt-"));
    temporaryDirectories.push(directory);
    const imagePath = join(directory, "sticker.webp");
    await writeFile(imagePath, "sticker-bytes");
    const message = baseMessage(13);
    message.content = { kind: "sticker" };
    message.attachments = [
      {
        kind: "sticker",
        fileId: "sticker",
        fileUniqueId: "sticker-u",
        width: 512,
        height: 512,
        stickerType: "regular",
        format: "static",
        localPath: imagePath,
      },
    ];

    const compiled = await compilePiPrompt(message, "session", emptyChat, {
      download: async (attachment) => attachment,
    });

    expect(compiled.images).toEqual([
      {
        type: "image",
        data: Buffer.from("sticker-bytes").toString("base64"),
        mimeType: "image/webp",
      },
    ]);
  });

  test("把结构化内容和媒体组写入 prompt", async () => {
    const message = baseMessage(13);
    message.content = {
      kind: "location",
      latitude: 31.2,
      longitude: 121.5,
      horizontalAccuracy: 10,
    };
    message.mediaGroupId = "album-1";

    const compiled = await compilePiPrompt(message, "session", emptyChat, {
      download: async (attachment) => attachment,
    });

    expect(compiled.message).toContain('group="album-1"');
    expect(compiled.message).toContain(
      'kind="location" latitude="31.2" longitude="121.5" accuracy="10"',
    );
    expect(compiled.indexedMessage.content).toEqual(message.content);
    expect(compiled.indexedMessage.mediaGroupId).toBe("album-1");
  });

  test("当前 document 把本机绝对路径写入 prompt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-prompt-"));
    temporaryDirectories.push(directory);
    const localPath = join(directory, "report.pdf");
    await writeFile(localPath, "pdf");
    const message = baseMessage(13);
    message.attachments = [
      {
        kind: "document",
        fileId: "report",
        fileUniqueId: "report-u",
        fileName: "report.pdf",
        mimeType: "application/pdf",
        localPath,
      },
    ];

    const compiled = await compilePiPrompt(message, "session", emptyChat, {
      download: async (attachment) => attachment,
    });

    expect(compiled.message).toContain(
      `<file kind="document" name="report.pdf" status="available" path="${localPath}" mime="application/pdf" size="3"/>`,
    );
  });

  test("当前超限 document 仍提交给 Agent", async () => {
    const message = baseMessage(14);
    message.attachments = [
      {
        kind: "document",
        fileId: "large",
        fileUniqueId: "large-u",
        fileName: "large.zip",
        size: 21 * 1024 * 1024,
        unavailableReason: "telegram_public_api_limit",
      },
    ];

    const compiled = await compilePiPrompt(message, "session", emptyChat, {
      download: async (attachment) => attachment,
    });

    expect(compiled.images).toEqual([]);
    expect(compiled.message).toContain(
      '<file kind="document" name="large.zip" status="unavailable" reason="telegram_public_api_limit" limit="20971520" size="22020096"/>',
    );
    expect(compiled.message).toEndWith("\n正文");
  });
});

function baseMessage(messageId: number): NormalizedTelegramMessage {
  return {
    updateId: messageId,
    chatId: 1,
    messageId,
    sentAt: "2026-09-01T00:00:00Z",
    sender: { id: 1, displayName: "User" },
    text: "正文",
    attachments: [],
  };
}

function replyMessage(messageId: number): NormalizedTelegramMessage {
  return {
    ...baseMessage(messageId),
    reply: { messageId: 10, quote: { text: "选区" } },
  };
}
