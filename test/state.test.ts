import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateChatState, indexMessage, StateStore } from "../src/state";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("StateStore", () => {
  test("原子保存并重新读取 chat、session 和消息索引", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-state-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state.json");
    const store = await StateStore.open(path);

    await store.update((state) => {
      state.lastUpdateId = 1001;
      const chat = getOrCreateChatState(state, 123456789);
      chat.session = {
        id: "session-1",
        file: "/sessions/session-1.jsonl",
        materialized: false,
      };
      indexMessage(chat, {
        messageId: 42,
        role: "user",
        piSessionId: "session-1",
        sentAt: "2026-09-01T16:10:56Z",
        text: "test",
        attachments: [
          {
            kind: "document",
            fileId: "large",
            fileUniqueId: "large-u",
            fileName: "large.zip",
            unavailableReason: "telegram_public_api_limit",
          },
        ],
      });
    });

    const reopened = await StateStore.open(path);
    const snapshot = reopened.snapshot();

    expect(snapshot.lastUpdateId).toBe(1001);
    expect(snapshot.chats["123456789"]?.session).toEqual({
      id: "session-1",
      file: "/sessions/session-1.jsonl",
      materialized: false,
    });
    expect(snapshot.chats["123456789"]?.messages["42"]?.text).toBe("test");
    expect(
      snapshot.chats["123456789"]?.messages["42"]?.attachments[0],
    ).toMatchObject({ unavailableReason: "telegram_public_api_limit" });
  });

  test("兼容没有 materialized 字段的旧 session 指针", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-state-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state.json");
    await writeFile(
      path,
      `${JSON.stringify({
        version: 1,
        chats: {
          "1": {
            session: { id: "session-1", file: "/sessions/session-1.jsonl" },
            messageOrder: [],
            messages: {},
          },
        },
      })}\n`,
    );

    const store = await StateStore.open(path);

    expect(store.snapshot().chats["1"]?.session).toEqual({
      id: "session-1",
      file: "/sessions/session-1.jsonl",
    });
  });

  test("持久化扩展内容和媒体附件 union", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-state-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state.json");
    const store = await StateStore.open(path);

    await store.update((state) => {
      indexMessage(getOrCreateChatState(state, 1), {
        messageId: 2,
        role: "user",
        piSessionId: "session",
        sentAt: "2026-09-01T00:00:00Z",
        text: "audio",
        content: { kind: "audio" },
        mediaGroupId: "group-1",
        attachments: [
          {
            kind: "audio",
            fileId: "audio",
            fileUniqueId: "audio-u",
            fileName: "song.mp3",
            mimeType: "audio/mpeg",
            duration: 42,
            performer: "Artist",
            title: "Song",
            localPath: "/safe/song.mp3",
          },
        ],
      });
      indexMessage(getOrCreateChatState(state, 1), {
        messageId: 3,
        role: "user",
        piSessionId: "session",
        sentAt: "2026-09-01T00:00:01Z",
        text: "",
        content: {
          kind: "poll",
          question: "Choose",
          options: [{ text: "One", voterCount: 0 }],
          totalVoterCount: 0,
          closed: false,
          anonymous: true,
          pollType: "regular",
          multipleAnswers: false,
          allowsRevoting: false,
          membersOnly: false,
          openPeriod: 60,
          closeDate: 1_788_280_000,
          media: [
            {
              kind: "link",
              section: "description",
              url: "https://example.com",
            },
          ],
        },
        attachments: [
          {
            kind: "photo",
            fileId: "poll-photo",
            fileUniqueId: "poll-photo-u",
            width: 640,
            height: 480,
            source: "poll",
            sourceSection: "option",
            sourceIndex: 0,
            localPath: "/safe/poll-photo.jpg",
          },
        ],
      });
      indexMessage(getOrCreateChatState(state, 1), {
        messageId: 4,
        role: "user",
        piSessionId: "session",
        sentAt: "2026-09-01T00:00:02Z",
        text: "",
        content: {
          kind: "paid_media",
          starCount: 5,
          itemCount: 1,
          unavailableItemCount: 1,
          unavailableReasons: ["content_unavailable"],
          previews: [{ index: 0, width: 640, height: 360, duration: 5 }],
        },
        attachments: [],
      });
    });

    const reopened = (await StateStore.open(path)).snapshot().chats["1"];
    const message = reopened?.messages["2"];
    expect(message?.content).toEqual({ kind: "audio" });
    expect(message?.mediaGroupId).toBe("group-1");
    expect(message?.attachments[0]).toMatchObject({
      kind: "audio",
      duration: 42,
      performer: "Artist",
    });
    expect(reopened?.messages["3"]?.content).toMatchObject({
      kind: "poll",
      media: [{ kind: "link", section: "description" }],
    });
    expect(reopened?.messages["3"]?.attachments[0]).toMatchObject({
      source: "poll",
      sourceSection: "option",
      sourceIndex: 0,
    });
    expect(reopened?.messages["4"]?.content).toMatchObject({
      kind: "paid_media",
      previews: [{ index: 0, width: 640, height: 360, duration: 5 }],
    });
  });

  test("限制每个 chat 的消息索引数量", () => {
    const state = { version: 1 as const, chats: {} };
    const chat = getOrCreateChatState(state, 1);

    for (let messageId = 1; messageId <= 3; messageId += 1) {
      indexMessage(
        chat,
        {
          messageId,
          role: "user",
          piSessionId: "session",
          sentAt: "2026-09-01T00:00:00Z",
          text: String(messageId),
          attachments: [],
        },
        2,
      );
    }

    expect(chat.messageOrder).toEqual([2, 3]);
    expect(chat.messages["1"]).toBeUndefined();
  });
});
