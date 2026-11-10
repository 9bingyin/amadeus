import type {
  Chat,
  Message,
  MessageEntity,
  MessageOrigin,
  User,
} from "grammy/types";

const weekday = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  timeZone: "UTC",
});

function timestamp(unix: number, withWeekday = false): string {
  const date = new Date(unix * 1000);
  const time = date.toISOString().replace("T", " ").replace(".000Z", "Z");
  return withWeekday ? `${weekday.format(date)} ${time}` : time;
}

function clean(value = ""): string {
  return value
    .replace(/[\[\]\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function userLabel(user: User): string {
  return [
    clean(`${user.first_name} ${user.last_name ?? ""}`),
    user.username ? `(@${clean(user.username)})` : "",
    `id:${user.id}`,
  ]
    .filter(Boolean)
    .join(" ");
}

function chatLabel(chat: Chat): string {
  return (
    [
      clean(
        "title" in chat
          ? chat.title
          : `${chat.first_name} ${chat.last_name ?? ""}`,
      ),
      "username" in chat && chat.username ? `(@${clean(chat.username)})` : "",
    ]
      .filter(Boolean)
      .join(" ") || `id:${chat.id}`
  );
}

function renderText(text = "", entities: MessageEntity[] = []): string {
  for (const entity of entities
    .filter((item) => item.type === "text_link" || item.type === "text_mention")
    .toSorted((a, b) => b.offset + b.length - a.offset - a.length)) {
    const end = entity.offset + entity.length;
    const extra =
      entity.type === "text_link" ? entity.url : userLabel(entity.user);
    // Telegram 偏移和 JavaScript slice 均使用 UTF-16 code units。
    text = `${text.slice(0, end)} (${extra})${text.slice(end)}`;
  }
  return text;
}

function replyLine(message: Message): string {
  const reply = message.reply_to_message;
  let preview = message.quote
    ? renderText(message.quote.text, message.quote.entities).trim()
    : "";
  if (!preview && reply) {
    preview =
      renderText(
        reply.text ?? reply.caption,
        reply.entities ?? reply.caption_entities,
      )
        .trim()
        .split("\n")[0] ?? "";
    if (!preview && reply.photo) preview = "[image]";
  }
  const parts: string[] = [];
  if (reply) parts.push(`#${reply.message_id}`);
  if (preview) {
    const chars = Array.from(preview);
    parts.push(
      JSON.stringify(
        chars.length > 500 ? chars.slice(0, 500).join("") + "…" : preview,
      ),
    );
  }
  return parts.length ? `[Replying to: ${parts.join(" ")}]` : "";
}

function forwardLabel(origin: MessageOrigin): string {
  switch (origin.type) {
    case "user":
      return userLabel(origin.sender_user);
    case "hidden_user":
      return clean(origin.sender_user_name);
    case "chat":
      return chatLabel(origin.sender_chat);
    case "channel":
      return chatLabel(origin.chat);
  }
}

export function formatInboundMessage(message: Message): string {
  const header = `[${[
    "Telegram",
    `#${message.message_id}`,
    message.from ? userLabel(message.from) : "",
    timestamp(message.date, true),
  ]
    .filter(Boolean)
    .join(" ")}]`;
  const origin = message.forward_origin;
  const details = [
    replyLine(message),
    origin
      ? `[Forwarded from ${forwardLabel(origin)} at ${timestamp(origin.date)}]`
      : "",
  ].filter(Boolean);
  const body = renderText(
    message.text ?? message.caption,
    message.entities ?? message.caption_entities,
  ).trim();
  if (!details.length) return body ? `${header} ${body}` : header;
  return [header, ...details, body].filter(Boolean).join("\n");
}
