import { wrapSection } from "@earendil-works/pi-durable";
import { TelegramState } from "./conversations";

export const TelegramPrompt = wrapSection("platform", (platform) => ({
  ...platform,
  async render(input, context) {
    const body = await platform.render(input, context);
    const state = await input.read.snapshot(TelegramState, context);
    if (!Object.values(state?.chats ?? {}).includes(input.conversationId))
      return body;
    const telegram = `Each user message starts with [Telegram #<id> <sender> <time>]. Times are UTC; the text after the header is the message. One input may contain several messages.
[Replying to: ...] and [Forwarded from ...] describe that message.
[Telegram content] describes non-text content. <attachments> lists saved files; supported images also arrive as native image blocks. Use tools to inspect files when needed.
Your final answer is sent to this chat. Use send_file to send a local file.
Use ordinary Markdown, not MarkdownV2, with absolute http/https links. Reply in the user's language.`;
    return [`<telegram>\n${telegram}\n</telegram>`, body]
      .filter(Boolean)
      .join("\n");
  },
}));
