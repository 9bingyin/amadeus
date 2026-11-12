import { expect, test } from "bun:test";
import type { Message, MessageOrigin } from "grammy/types";
import { formatInboundMessage } from "./envelope";

const header = "[Telegram #187 Alice (@alice) id:42 Mon 2026-09-21 15:39:54Z]";
function message(): Message.TextMessage {
  return {
    message_id: 187,
    date: Date.parse("2026-09-21T15:39:54Z") / 1000,
    chat: { id: 42, type: "private", first_name: "Alice" },
    from: { id: 42, is_bot: false, first_name: "Alice", username: "alice" },
    text: "这是什么",
  };
}

function asReply(source: Message): NonNullable<Message["reply_to_message"]> {
  // grammY requires reply_to_message: undefined; Telegram omits it at runtime.
  return source as NonNullable<Message["reply_to_message"]>;
}

test("Uses the original UTC timestamp and sanitizes labels without changing the body", () => {
  expect(formatInboundMessage(message())).toBe(`${header} 这是什么`);
  const source = message();
  source.from = {
    id: 42,
    is_bot: false,
    first_name: "A[lice]\n",
    last_name: "Smith]",
    username: "alice",
  };
  source.text = "keep [this]\n保留换行";
  expect(formatInboundMessage(source)).toBe(
    "[Telegram #187 A lice Smith (@alice) id:42 Mon 2026-09-21 15:39:54Z] keep [this]\n保留换行",
  );
});

test("Preserves reply IDs and prefers selected quote text", () => {
  const source = message();
  source.reply_to_message = asReply({
    ...message(),
    message_id: 186,
    text: "原文\n第二行",
  });
  expect(formatInboundMessage(source)).toBe(
    `${header}\n[Replying to: #186 "原文"]\n这是什么`,
  );
  const quote = '选中的 "引文"\n下一行';
  source.quote = { text: quote, position: 0, is_manual: true };
  expect(formatInboundMessage(source)).toBe(
    `${header}\n[Replying to: #186 ${JSON.stringify(quote)}]\n这是什么`,
  );
});

test("Truncates reply previews by Unicode code point and retains empty reply links", () => {
  const source = message();
  const character = "\u{1f642}";
  source.quote = { text: character.repeat(501), position: 0 };
  expect(formatInboundMessage(source)).toBe(
    `${header}\n[Replying to: "${character.repeat(500)}…"]\n这是什么`,
  );
  delete source.quote;
  source.reply_to_message = asReply({
    ...message(),
    message_id: 186,
    text: "",
  });
  expect(formatInboundMessage(source)).toBe(
    `${header}\n[Replying to: #186]\n这是什么`,
  );
  source.reply_to_message = asReply({
    message_id: 186,
    date: 1,
    chat: source.chat,
    photo: [{ file_id: "photo", file_unique_id: "photo", width: 1, height: 1 }],
  });
  expect(formatInboundMessage(source)).toBe(
    `${header}\n[Replying to: #186 "[image]"]\n这是什么`,
  );
});

test("Preserves forwarded sender types and original timestamps", () => {
  const date = Date.parse("2026-09-21T13:58:44Z") / 1000;
  const cases: [MessageOrigin, string][] = [
    [
      {
        type: "user",
        date,
        sender_user: {
          id: 7,
          is_bot: false,
          first_name: "Bob",
          username: "bob",
        },
      },
      "Bob (@bob) id:7",
    ],
    [
      { type: "hidden_user", date, sender_user_name: "Anonymous [name]\n" },
      "Anonymous name",
    ],
    [
      {
        type: "chat",
        date,
        sender_chat: { id: -1, type: "group", title: "Example Group" },
      },
      "Example Group",
    ],
    [
      {
        type: "channel",
        date,
        message_id: 12,
        chat: {
          id: -2,
          type: "channel",
          title: "Example Channel",
          username: "example",
        },
      },
      "Example Channel (@example)",
    ],
  ];
  for (const [origin, label] of cases) {
    expect(formatInboundMessage({ ...message(), forward_origin: origin })).toBe(
      `${header}\n[Forwarded from ${label} at 2026-09-21 13:58:44Z]\n这是什么`,
    );
  }
});

test("Expands hidden links and mentions using Telegram UTF-16 offsets", () => {
  const source = message();
  source.text = "\u{1f642} 看这里 找Alice";
  source.entities = [
    {
      type: "text_link",
      offset: source.text.indexOf("这里"),
      length: 2,
      url: "https://example.com",
    },
    {
      type: "text_mention",
      offset: source.text.indexOf("Alice"),
      length: 5,
      user: { id: 7, is_bot: false, first_name: "Bob", username: "bob" },
    },
  ];
  const body =
    "\u{1f642} 看这里 (https://example.com) 找Alice (Bob (@bob) id:7)";
  expect(formatInboundMessage(source)).toBe(`${header} ${body}`);
  const photo: Message.PhotoMessage = {
    message_id: source.message_id,
    date: source.date,
    chat: source.chat,
    photo: [{ file_id: "photo", file_unique_id: "photo", width: 1, height: 1 }],
    caption: source.text,
    caption_entities: source.entities,
  };
  if (source.from) photo.from = source.from;
  expect(formatInboundMessage(photo)).toBe(`${header} ${body}`);
  delete photo.caption;
  delete photo.caption_entities;
  expect(formatInboundMessage(photo)).toBe(header);
});
