import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message } from "grammy/types";
import {
  classifyTelegramContentMessage,
  TELEGRAM_CONTENT_KIND_ORDER,
} from "../../src/telegram/content-types";

const baseMessage = {
  message_id: 1,
  date: 1_788_279_056,
  chat: { id: 1, type: "private", first_name: "User" },
  from: { id: 1, is_bot: false, first_name: "User" },
} as const;

describe("Telegram 内容类型覆盖矩阵", () => {
  test("与 @grammyjs/types 5.0 的 20 个内容 alias 一一对应", () => {
    expect(TELEGRAM_CONTENT_KIND_ORDER).toEqual([
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
    ]);
  });

  test("自动对照 installed message.d.ts 的内容 alias", async () => {
    const source = await readFile(
      join(process.cwd(), "node_modules/@grammyjs/types/message.d.ts"),
      "utf8",
    );
    expect(discoverContentFields(source)).toEqual(
      [...TELEGRAM_CONTENT_KIND_ORDER].sort(),
    );
  });

  test("上游 alias 换成多行声明时仍会被检测", () => {
    const source = `export declare namespace Message {
    type TextMessage = CommonMessage & MsgWith<"text">;
    type FutureMessage =
        CommonMessage &
        MsgWith<"future_content">;
    type FutureServiceMessage =
        ServiceMessage &
        MsgWith<"future_service">;
}
type ReplyMessage = Message.TextMessage;`;

    expect(discoverContentFields(source)).toEqual(["future_content", "text"]);
  });

  test("兼容字段重叠时选择语义更具体的内容类型", () => {
    const file = { file_id: "file", file_unique_id: "unique" };
    expect(
      classifyTelegramContentMessage({
        ...baseMessage,
        animation: { ...file, width: 1, height: 1, duration: 1 },
        document: file,
      } as Message)?.kind,
    ).toBe("animation");
    expect(
      classifyTelegramContentMessage({
        ...baseMessage,
        live_photo: {
          ...file,
          width: 1,
          height: 1,
          duration: 1,
          photo: [{ ...file, width: 1, height: 1 }],
        },
        photo: [{ ...file, width: 1, height: 1 }],
      } as Message)?.kind,
    ).toBe("live_photo");
    expect(
      classifyTelegramContentMessage({
        ...baseMessage,
        venue: {
          location: { latitude: 1, longitude: 2 },
          title: "Venue",
          address: "Address",
        },
        location: { latitude: 1, longitude: 2 },
      } as Message)?.kind,
    ).toBe("venue");
  });

  test("未知或服务字段返回明确的未分类结果", () => {
    expect(
      classifyTelegramContentMessage({
        ...baseMessage,
        direct_message_price_changed: {
          are_direct_messages_enabled: true,
        },
      } as Message),
    ).toBeUndefined();
  });
});

function discoverContentFields(source: string): string[] {
  const namespace = source.match(
    /export declare namespace Message\s*\{([\s\S]*?)\r?\n\}\r?\ntype ReplyMessage/,
  )?.[1];
  if (namespace === undefined) {
    throw new Error("无法解析 @grammyjs/types Message namespace");
  }
  const declarations = [
    ...namespace.matchAll(/^[ \t]{4}type (\w+Message) =[ \t]*/gm),
  ];
  const aliases = new Map<string, string>();
  for (const [index, declaration] of declarations.entries()) {
    const name = declaration[1];
    const start = (declaration.index ?? 0) + declaration[0].length;
    const end = declarations[index + 1]?.index ?? namespace.length;
    const body = namespace.slice(start, end);
    const semicolon = body.indexOf(";");
    if (name !== undefined && semicolon >= 0) {
      aliases.set(name, body.slice(0, semicolon));
    }
  }
  const contentAliases = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, expression] of aliases) {
      if (contentAliases.has(name) || expression.includes("ServiceMessage")) {
        continue;
      }
      const parent = expression.trimStart().match(/^(\w+Message)\b/)?.[1];
      if (
        /\b(?:CommonMessage|CaptionableMessage|MediaMessage)\b/.test(
          expression,
        ) ||
        (parent !== undefined && contentAliases.has(parent))
      ) {
        contentAliases.add(name);
        changed = true;
      }
    }
  }
  return [...contentAliases]
    .map((name) => aliases.get(name)?.match(/MsgWith<"([^"]+)">/)?.[1])
    .filter((field): field is string => field !== undefined)
    .sort();
}
