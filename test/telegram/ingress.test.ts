import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "grammy";
import type {
  Message,
  MessageEntity,
  Update,
  UserFromGetMe,
} from "grammy/types";
import { createInfoLogger, type InfoLogger } from "../../src/logging/logger";
import { StateStore } from "../../src/state";
import { TelegramVoiceTranscriber } from "../../src/stt/transcriber";
import {
  TelegramDownloadError,
  TelegramFileDownloader,
} from "../../src/telegram/download";
import { installTelegramIngress } from "../../src/telegram/ingress";
import type {
  NormalizedTelegramMessage,
  TelegramContentKind,
} from "../../src/telegram/types";
import { RecordingLogger } from "../helpers/recording-logger";
import { dispatchTelegramMessage } from "../../src/app";

const temporaryDirectories: string[] = [];
const botInfo = {
  id: 999,
  is_bot: true,
  first_name: "Amadeus",
  username: "amadeus_test_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
} satisfies UserFromGetMe;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("installTelegramIngress", () => {
  test("voice 下载停滞时仍交付不可用状态并完成 ingress 关闭", async () => {
    const root = await mkdtemp(join(tmpdir(), "amadeus-ingress-download-"));
    temporaryDirectories.push(root);
    const stateStore = await StateStore.open(join(root, "state.json"));
    const bot = new Bot("123:token", { botInfo });
    const started = Promise.withResolvers<void>();
    let cancelled = false;
    let delivered = false;
    const downloader = new TelegramFileDownloader({
      api: { getFile: async () => ({ file_path: "voice.ogg" }) },
      botToken: "synthetic-token",
      downloadsDir: root,
      voiceTimeoutMs: 20,
      fetch: async () => {
        started.resolve();
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        );
      },
    });
    const stt = new TelegramVoiceTranscriber(
      {
        enabled: true,
        apiKey: "synthetic-key",
        model: "microsoft/mai-transcribe-2",
        ffmpegCommand: "ffmpeg",
        timeoutMs: 1000,
        maxDurationSeconds: 600,
      },
      stateStore,
      {
        convert: async () => {
          throw new Error("must not convert unavailable audio");
        },
      },
      {
        transcribe: async () => {
          throw new Error("must not request unavailable audio");
        },
      },
    );
    const controller = installTelegramIngress(bot, {
      allowedUserIds: new Set([1]),
      stateStore,
      downloader,
      voiceTranscriber: stt,
      logger: new RecordingLogger(),
      handlers: {
        onMessage: async (message) => {
          delivered = true;
          expect(message.attachments[0]).toMatchObject({
            unavailableReason: "download_failed",
            transcription: { status: "unavailable", code: "audio_unavailable" },
          });
        },
        onNewSession: async () => {},
        onCompact: async () => {},
        onRestart: async () => {},
        onStatus: async () => {},
        onStop: async () => {},
        onUserError: async () => {},
      },
    });
    const update = bot.handleUpdate(
      contentUpdate(1, 1, 1, {
        voice: {
          file_id: "voice-id",
          file_unique_id: "voice-unique",
          duration: 1,
        },
      }),
    );
    await started.promise;
    const closing = controller.close(async () => {});
    await Promise.all([update, closing]);
    expect(cancelled).toBeTrue();
    expect(delivered).toBeTrue();
    expect(stateStore.snapshot().lastUpdateId).toBe(1);
  });
  test.each([false, true])(
    "voice 转录成功或失败均交付原附件，派发失败重投复用转录且不提前推进 offset",
    async (failTranscription) => {
      const directory = await mkdtemp(join(tmpdir(), "amadeus-ingress-stt-"));
      temporaryDirectories.push(directory);
      const stateStore = await StateStore.open(join(directory, "state.json"));
      const bot = new Bot("123:token", { botInfo });
      let calls = 0;
      let dispatches = 0;
      const voiceTranscriber = new TelegramVoiceTranscriber(
        {
          enabled: true,
          apiKey: "synthetic-key",
          model: "microsoft/mai-transcribe-2",
          ffmpegCommand: "ffmpeg",
          timeoutMs: 1000,
          maxDurationSeconds: 600,
        },
        stateStore,
        { convert: async () => new Uint8Array([1]) },
        {
          transcribe: async () => {
            calls++;
            if (failTranscription) throw new Error("synthetic-private-error");
            return "合成转录文本";
          },
        },
      );
      const controller = installTelegramIngress(bot, {
        allowedUserIds: new Set([1]),
        stateStore,
        voiceTranscriber,
        downloader: {
          download: async (attachment) => ({
            ...attachment,
            localPath: "/fixture/voice.ogg",
          }),
        },
        logger: new RecordingLogger(),
        handlers: {
          onMessage: (message) =>
            dispatchTelegramMessage(
              async () => {
                dispatches++;
                if (message.content?.kind === "voice")
                  expect(message.attachments[0]).toMatchObject({
                    localPath: "/fixture/voice.ogg",
                    transcription: failTranscription
                      ? { status: "unavailable", code: "request_failed" }
                      : { status: "completed", text: "合成转录文本" },
                  });
                if (dispatches === 1)
                  throw new Error("synthetic-dispatch-failure");
              },
              async () => {},
            ),
          onNewSession: async () => {},
          onCompact: async () => {},
          onRestart: async () => {},
          onStatus: async () => {},
          onStop: async () => {},
          onUserError: async () => {},
        },
      });
      const payload = {
        voice: {
          file_id: "voice-id",
          file_unique_id: "voice-unique",
          duration: 2,
          mime_type: "audio/ogg",
        },
      };
      await bot.handleUpdate(contentUpdate(1, 2, 1, payload));
      expect(calls).toBe(0);
      await expect(
        bot.handleUpdate(contentUpdate(2, 1, 2, payload)),
      ).rejects.toThrow();
      expect(stateStore.snapshot().lastUpdateId).toBe(1);
      await bot.handleUpdate(contentUpdate(2, 1, 2, payload));
      await bot.handleUpdate(contentUpdate(3, 1, 2, payload));
      expect(calls).toBe(1);
      expect(dispatches).toBe(2);
      await bot.handleUpdate(
        contentUpdate(4, 1, 3, {
          audio: {
            file_id: "audio-id",
            file_unique_id: "audio-unique",
            duration: 2,
          },
        }),
      );
      expect(calls).toBe(1);
      await controller.close(async () => {});
    },
  );
  test("静默忽略非白名单，按 chat message_id 去重，并让命令绕过模型消息", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-ingress-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const bot = new Bot("123:token", { botInfo });
    const messages: NormalizedTelegramMessage[] = [];
    const newSessions: number[] = [];
    const statuses: number[] = [];
    const stops: number[] = [];
    const compactions: number[] = [];
    const restarts: number[] = [];
    const errors: string[] = [];
    const recording = new RecordingLogger();
    const lines: string[] = [];
    const formatted = createInfoLogger({
      now: () => new Date("2026-09-01T00:00:00Z"),
      writeLine: (line) => lines.push(line),
    });
    const logger: InfoLogger = {
      info(event, fields) {
        recording.info(event, fields);
        formatted.info(event, fields);
      },
    };

    installTelegramIngress(bot, {
      allowedUserIds: new Set([1]),
      stateStore,
      downloader: {
        download: async (attachment) => ({
          ...attachment,
          localPath: "/safe/file",
        }),
      },
      logger,
      handlers: {
        onMessage: async (message) => {
          messages.push(message);
        },
        onNewSession: async (message) => {
          newSessions.push(message.messageId);
        },
        onCompact: async (message) => {
          compactions.push(message.messageId);
        },
        onRestart: async (message) => {
          restarts.push(message.messageId);
        },
        onStatus: async (message) => {
          statuses.push(message.messageId);
        },
        onStop: async (message) => {
          stops.push(message.messageId);
        },
        onUserError: async (_message, error) => {
          errors.push(error.code);
        },
      },
    });

    await bot.handleUpdate(textUpdate(1, 2, 10, "unauthorized"));
    await bot.handleUpdate(groupTextUpdate(2, 1, 20, "group message"));
    await bot.handleUpdate(textUpdate(3, 1, 11, "hello"));
    await bot.handleUpdate(
      textUpdate(4, 1, 11, "hello duplicated in a new update"),
    );
    await bot.handleUpdate(
      textUpdate(5, 1, 12, "/new", [
        { type: "bot_command", offset: 0, length: 4 },
      ]),
    );
    await bot.handleUpdate(
      textUpdate(6, 1, 13, "/status", [
        { type: "bot_command", offset: 0, length: 7 },
      ]),
    );
    await bot.handleUpdate(
      textUpdate(7, 1, 14, "/stop", [
        { type: "bot_command", offset: 0, length: 5 },
      ]),
    );
    await bot.handleUpdate(
      textUpdate(8, 1, 15, "/compact", [
        { type: "bot_command", offset: 0, length: 8 },
      ]),
    );
    await bot.handleUpdate(
      textUpdate(9, 1, 16, "/restart", [
        { type: "bot_command", offset: 0, length: 8 },
      ]),
    );

    expect(messages.map((message) => message.text)).toEqual(["hello"]);
    expect(newSessions).toEqual([12]);
    expect(statuses).toEqual([13]);
    expect(stops).toEqual([14]);
    expect(compactions).toEqual([15]);
    expect(restarts).toEqual([16]);
    expect(errors).toEqual([]);
    expect(stateStore.snapshot().lastUpdateId).toBe(9);
    expect(stateStore.snapshot().chats["1"]?.seenMessageOrder).toEqual([
      11, 12, 13, 14, 15, 16,
    ]);
    expect(recording.events()).toEqual([
      "telegram_update_ignored",
      "telegram_update_ignored",
      "telegram_message_accepted",
      "telegram_update_ignored",
      "telegram_command_accepted",
      "telegram_command_accepted",
      "telegram_command_accepted",
      "telegram_command_accepted",
      "telegram_command_accepted",
    ]);
    expect(
      recording.entries.find(
        (entry) => entry.event === "telegram_message_accepted",
      ),
    ).toMatchObject({ fields: { message_type: "text" } });
    expect(
      lines.every((line) => line.includes(" level=info event=")),
    ).toBeTrue();
    expect(lines.every((line) => !line.includes("\n"))).toBeTrue();
    expect(lines.join("\n")).not.toContain("unauthorized");
    expect(lines.join("\n")).not.toContain("group message");
    expect(lines.join("\n")).not.toContain("hello");
    expect(lines.join("\n")).not.toMatch(/[\u4e00-\u9fff]/);
  });

  test("失败的普通消息 update 不会被确认并可再次处理", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-ingress-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const bot = new Bot("123:token", { botInfo });
    let attempts = 0;

    installTelegramIngress(bot, {
      allowedUserIds: new Set([1]),
      stateStore,
      logger: new RecordingLogger(),
      downloader: { download: async (attachment) => attachment },
      handlers: {
        onMessage: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("message failed");
          }
        },
        onNewSession: async () => undefined,
        onCompact: async () => undefined,
        onRestart: async () => undefined,
        onStatus: async () => undefined,
        onStop: async () => undefined,
        onUserError: async () => undefined,
      },
    });
    const update = textUpdate(10, 1, 17, "retry");

    await expect(bot.handleUpdate(update)).rejects.toThrow("message failed");
    expect(stateStore.snapshot().lastUpdateId).toBeUndefined();

    await bot.handleUpdate(update);
    expect(attempts).toBe(2);
    expect(stateStore.snapshot().lastUpdateId).toBe(10);
  });

  test("关闭会在成功持久化当前 update 后再停止轮询", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-ingress-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const bot = new Bot("123:token", { botInfo });
    let releaseMessage: (() => void) | undefined;
    const messagePending = new Promise<void>((resolve) => {
      releaseMessage = resolve;
    });
    let messageStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      messageStarted = resolve;
    });
    let stopCalls = 0;

    const ingress = installTelegramIngress(bot, {
      allowedUserIds: new Set([1]),
      stateStore,
      logger: new RecordingLogger(),
      downloader: { download: async (attachment) => attachment },
      handlers: {
        onMessage: async () => {
          messageStarted?.();
          await messagePending;
        },
        onNewSession: async () => undefined,
        onCompact: async () => undefined,
        onRestart: async () => undefined,
        onStatus: async () => undefined,
        onStop: async () => undefined,
        onUserError: async () => undefined,
      },
    });

    const processing = bot.handleUpdate(textUpdate(10, 1, 17, "slow"));
    await started;
    const closing = ingress.close(async () => {
      stopCalls += 1;
      expect(stateStore.snapshot().lastUpdateId).toBe(10);
    });
    await Promise.resolve();
    expect(stopCalls).toBe(0);

    releaseMessage?.();
    await Promise.all([processing, closing]);
    expect(stopCalls).toBe(1);
  });

  test("当前 update 失败时关闭不会用更大 offset 确认它", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-ingress-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const bot = new Bot("123:token", { botInfo });
    let releaseMessage: (() => void) | undefined;
    const messagePending = new Promise<void>((resolve) => {
      releaseMessage = resolve;
    });
    let messageStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      messageStarted = resolve;
    });
    let stopCalls = 0;

    const ingress = installTelegramIngress(bot, {
      allowedUserIds: new Set([1]),
      stateStore,
      logger: new RecordingLogger(),
      downloader: { download: async (attachment) => attachment },
      handlers: {
        onMessage: async () => {
          messageStarted?.();
          await messagePending;
          throw new Error("message failed");
        },
        onNewSession: async () => undefined,
        onCompact: async () => undefined,
        onRestart: async () => undefined,
        onStatus: async () => undefined,
        onStop: async () => undefined,
        onUserError: async () => undefined,
      },
    });

    const processing = bot.handleUpdate(textUpdate(10, 1, 17, "slow"));
    void processing.catch(() => undefined);
    await started;
    const closing = ingress.close(async () => {
      stopCalls += 1;
    });

    releaseMessage?.();
    await expect(processing).rejects.toThrow("message failed");
    await closing;
    expect(stopCalls).toBe(0);
    expect(stateStore.snapshot().lastUpdateId).toBeUndefined();
  });

  test("长轮询关闭不会确认正在失败的 update", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-ingress-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const apiCalls: Array<{
      method: string;
      payload: Record<string, unknown>;
    }> = [];
    const update = textUpdate(10, 1, 17, "slow");
    let delivered = false;
    const fetchApi = Object.assign(
      async (...[input, init]: Parameters<typeof fetch>): Promise<Response> => {
        const method = new URL(String(input)).pathname.split("/").at(-1) ?? "";
        const payload = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        apiCalls.push({ method, payload });
        let result: unknown = [];
        if (method === "getUpdates" && !delivered) {
          delivered = true;
          result = [update];
        } else if (method === "deleteWebhook") {
          result = true;
        }
        return new Response(JSON.stringify({ ok: true, result }), {
          headers: { "content-type": "application/json" },
        });
      },
      { preconnect: fetch.preconnect },
    ) satisfies typeof fetch;
    const bot = new Bot("123:token", {
      botInfo,
      client: { fetch: fetchApi },
    });
    let releaseMessage: (() => void) | undefined;
    const messagePending = new Promise<void>((resolve) => {
      releaseMessage = resolve;
    });
    let messageStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      messageStarted = resolve;
    });
    const ingress = installTelegramIngress(bot, {
      allowedUserIds: new Set([1]),
      stateStore,
      logger: new RecordingLogger(),
      downloader: { download: async (attachment) => attachment },
      handlers: {
        onMessage: async () => {
          messageStarted?.();
          await messagePending;
          throw new Error("message failed");
        },
        onNewSession: async () => undefined,
        onCompact: async () => undefined,
        onRestart: async () => undefined,
        onStatus: async () => undefined,
        onStop: async () => undefined,
        onUserError: async () => undefined,
      },
    });
    bot.catch((failure) => {
      throw failure;
    });

    const polling = bot.start({ limit: 1, allowed_updates: ["message"] });
    void polling.catch(() => undefined);
    await started;
    const closing = ingress.close(() => bot.stop());
    releaseMessage?.();

    await expect(polling).rejects.toThrow();
    await closing;
    expect(
      apiCalls
        .filter((call) => call.method === "getUpdates")
        .map((call) => call.payload.offset),
    ).toEqual([1]);
    expect(stateStore.snapshot().lastUpdateId).toBeUndefined();
  });

  test("长时间控制命令不会阻塞后续 Telegram 更新", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-ingress-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const bot = new Bot("123:token", { botInfo });
    let releaseStatus: (() => void) | undefined;
    const statusPending = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    let statusCalls = 0;

    const ingress = installTelegramIngress(bot, {
      allowedUserIds: new Set([1]),
      stateStore,
      logger: new RecordingLogger(),
      downloader: { download: async (attachment) => attachment },
      handlers: {
        onMessage: async () => undefined,
        onNewSession: async () => undefined,
        onCompact: async () => undefined,
        onRestart: async () => undefined,
        onStatus: async () => {
          statusCalls += 1;
          await statusPending;
        },
        onStop: async () => undefined,
        onUserError: async () => undefined,
      },
    });

    const statusUpdate = bot.handleUpdate(
      textUpdate(10, 1, 17, "/status", [
        { type: "bot_command", offset: 0, length: 7 },
      ]),
    );
    const returnedBeforeHandler = await Promise.race([
      statusUpdate.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 10)),
    ]);

    const closing = ingress.close(async () => {
      throw new Error("polling stop failed");
    });
    void closing.catch(() => undefined);
    const closedBeforeHandler = await Promise.race([
      closing.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 10)),
    ]);
    await bot.handleUpdate(
      textUpdate(11, 1, 18, "/status", [
        { type: "bot_command", offset: 0, length: 7 },
      ]),
    );

    releaseStatus?.();
    await statusUpdate;
    await expect(closing).rejects.toThrow("polling stop failed");
    expect(returnedBeforeHandler).toBeTrue();
    expect(closedBeforeHandler).toBeFalse();
    expect(statusCalls).toBe(1);
  });

  test("全部 20 类内容消息都进入 Agent，服务消息保持边界", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-ingress-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const bot = new Bot("123:token", { botInfo });
    const messages: NormalizedTelegramMessage[] = [];
    const errors: string[] = [];
    const lines: string[] = [];
    const logger = createInfoLogger({
      now: () => new Date("2026-09-01T00:00:00Z"),
      writeLine: (line) => lines.push(line),
    });

    installTelegramIngress(bot, {
      allowedUserIds: new Set([1]),
      stateStore,
      logger,
      downloader: {
        download: async (attachment) => ({
          ...attachment,
          localPath: `/private/media/${attachment.fileUniqueId}`,
        }),
      },
      handlers: {
        onMessage: async (message) => {
          messages.push(message);
        },
        onNewSession: async () => undefined,
        onCompact: async () => undefined,
        onRestart: async () => undefined,
        onStatus: async () => undefined,
        onStop: async () => undefined,
        onUserError: async (_message, error) => {
          errors.push(error.code);
        },
      },
    });

    const file = {
      file_id: "secret-file-id",
      file_unique_id: "secret-file-unique",
    };
    const photo = [{ ...file, width: 800, height: 600 }];
    const animation = { ...file, width: 640, height: 360, duration: 3 };
    const payloads: Array<{
      kind: TelegramContentKind;
      payload: Partial<Message>;
    }> = [
      { kind: "text", payload: { text: "private text" } },
      {
        kind: "rich_message",
        payload: {
          rich_message: {
            blocks: [
              { type: "paragraph", text: "private rich text" },
              {
                type: "buttons",
                buttons: [
                  { text: "Run", callback_data: "private callback data" },
                ],
              },
            ],
          },
        },
      },
      {
        kind: "animation",
        payload: { animation, document: file },
      },
      { kind: "audio", payload: { audio: { ...file, duration: 4 } } },
      { kind: "document", payload: { document: file } },
      {
        kind: "live_photo",
        payload: {
          live_photo: {
            ...file,
            width: 800,
            height: 600,
            duration: 3,
            photo,
          },
          photo,
        },
      },
      {
        kind: "paid_media",
        payload: {
          paid_media: {
            star_count: 10,
            paid_media: [{ type: "preview", width: 800, height: 600 }],
          },
        },
      },
      { kind: "photo", payload: { photo } },
      {
        kind: "sticker",
        payload: {
          sticker: {
            ...file,
            type: "regular",
            width: 512,
            height: 512,
            is_animated: false,
            is_video: false,
          },
        },
      },
      {
        kind: "story",
        payload: {
          story: {
            chat: { id: 1, type: "private", first_name: "Private" },
            id: 9,
          },
        },
      },
      {
        kind: "video",
        payload: {
          video: { ...file, width: 1920, height: 1080, duration: 30 },
        },
      },
      {
        kind: "video_note",
        payload: { video_note: { ...file, length: 384, duration: 10 } },
      },
      { kind: "voice", payload: { voice: { ...file, duration: 8 } } },
      {
        kind: "contact",
        payload: {
          contact: {
            phone_number: "+private-phone",
            first_name: "Private Contact",
          },
        },
      },
      { kind: "dice", payload: { dice: { emoji: "dice", value: 6 } } },
      {
        kind: "game",
        payload: {
          game: {
            title: "Private Game",
            description: "Private Description",
            photo,
            text: "Private Scores",
            text_entities: [],
            animation,
          },
        },
      },
      {
        kind: "poll",
        payload: {
          poll: {
            id: "private-poll-id",
            question: "Private Question",
            options: [
              {
                persistent_id: "private-option-id",
                text: "Private Option",
                voter_count: 0,
              },
            ],
            total_voter_count: 0,
            is_closed: false,
            is_anonymous: true,
            type: "regular",
            allows_multiple_answers: false,
            allows_revoting: false,
            members_only: false,
          },
        },
      },
      {
        kind: "venue",
        payload: {
          venue: {
            location: { latitude: 31.2345, longitude: 121.5432 },
            title: "Private Venue",
            address: "Private Address",
          },
          location: { latitude: 0, longitude: 0 },
        },
      },
      {
        kind: "location",
        payload: { location: { latitude: 31.2345, longitude: 121.5432 } },
      },
      {
        kind: "checklist",
        payload: {
          checklist: {
            title: "Private Checklist",
            tasks: [{ id: 1, text: "Private Task" }],
          },
        },
      },
    ];

    for (const [index, item] of payloads.entries()) {
      await bot.handleUpdate(
        contentUpdate(index + 100, 1, index + 200, item.payload),
      );
    }
    await bot.handleUpdate(
      contentUpdate(999, 1, 999, {
        direct_message_price_changed: {
          are_direct_messages_enabled: true,
          direct_message_star_count: 10,
        },
      }),
    );

    expect(messages.map((message) => message.content?.kind)).toEqual(
      payloads.map(({ kind }) => kind),
    );
    expect(errors).toEqual(["unsupported"]);
    expect(
      lines.filter((line) => line.includes("event=telegram_message_accepted")),
    ).toHaveLength(payloads.length);
    expect(lines.join("\n")).toContain('message_type="rich_message"');
    expect(lines.join("\n")).toContain('reason="unsupported_message"');
    for (const forbidden of [
      "private text",
      "private rich text",
      "private callback data",
      "+private-phone",
      "Private Contact",
      "31.2345",
      "121.5432",
      "/private/media",
      "secret-file-id",
      "secret-file-unique",
      "Private Question",
      "Private Checklist",
    ]) {
      expect(lines.join("\n")).not.toContain(forbidden);
    }
  });

  test("附件超限或下载失败时仍把失败状态交给 Agent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-ingress-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const bot = new Bot("123:token", { botInfo });
    const messages: NormalizedTelegramMessage[] = [];
    const errors: string[] = [];
    const logger = new RecordingLogger();
    let downloadAttempt = 0;

    installTelegramIngress(bot, {
      allowedUserIds: new Set([1]),
      stateStore,
      logger,
      downloader: {
        download: async () => {
          downloadAttempt += 1;
          if (downloadAttempt === 1) {
            throw new TelegramDownloadError("too_large", "file is too big");
          }
          throw new Error("network failed");
        },
      },
      handlers: {
        onMessage: async (message) => {
          messages.push(message);
        },
        onNewSession: async () => undefined,
        onCompact: async () => undefined,
        onRestart: async () => undefined,
        onStatus: async () => undefined,
        onStop: async () => undefined,
        onUserError: async (_message, error) => {
          errors.push(error.code);
        },
      },
    });

    await bot.handleUpdate(documentUpdate(10, 1, 20));
    await bot.handleUpdate(documentUpdate(11, 1, 21));

    expect(errors).toEqual([]);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.attachments).toEqual([
      {
        kind: "document",
        fileId: "large-file",
        fileUniqueId: "large-unique",
        fileName: "large.zip",
        mimeType: "application/zip",
        size: 21 * 1024 * 1024,
        unavailableReason: "telegram_public_api_limit",
      },
    ]);
    expect(messages[1]?.attachments).toEqual([
      {
        kind: "document",
        fileId: "large-file",
        fileUniqueId: "large-unique",
        fileName: "large.zip",
        mimeType: "application/zip",
        size: 21 * 1024 * 1024,
        unavailableReason: "download_failed",
      },
    ]);
    expect(logger.events()).toContain("telegram_message_accepted");
    expect(logger.events()).not.toContain("telegram_input_rejected");
  });
});

function documentUpdate(
  updateId: number,
  userId: number,
  messageId: number,
): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1788279056,
      chat: { id: userId, type: "private", first_name: `User ${userId}` },
      from: { id: userId, is_bot: false, first_name: `User ${userId}` },
      document: {
        file_id: "large-file",
        file_unique_id: "large-unique",
        file_name: "large.zip",
        mime_type: "application/zip",
        file_size: 21 * 1024 * 1024,
      },
    },
  };
}

function contentUpdate(
  updateId: number,
  userId: number,
  messageId: number,
  payload: Partial<Message>,
): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1788279056,
      chat: { id: userId, type: "private", first_name: `User ${userId}` },
      from: { id: userId, is_bot: false, first_name: `User ${userId}` },
      ...payload,
    },
  } as Update;
}

function groupTextUpdate(
  updateId: number,
  userId: number,
  messageId: number,
  text: string,
): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1788279056,
      chat: { id: -100, type: "group", title: "Group" },
      from: { id: userId, is_bot: false, first_name: `User ${userId}` },
      text,
    },
  };
}

function textUpdate(
  updateId: number,
  userId: number,
  messageId: number,
  text: string,
  entities?: MessageEntity[],
): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1788279056,
      chat: { id: userId, type: "private", first_name: `User ${userId}` },
      from: { id: userId, is_bot: false, first_name: `User ${userId}` },
      text,
      ...(entities ? { entities } : {}),
    },
  };
}
