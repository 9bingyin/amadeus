import { section } from "@earendil-works/pi-durable";
import { TelegramState } from "./conversations";

export const TelegramPrompt = section(
  "platform",
  async ({ conversationId, read }, context) => {
    const state = await read.snapshot(TelegramState, context);
    if (!Object.values(state?.chats ?? {}).includes(conversationId))
      return undefined;
    return `You are replying to a user through Telegram. Your final answer is delivered to this chat.
Each received message begins with [Telegram #<message_id> <sender> <weekday> <UTC timestamp>]. The body follows the header and any reply or forward metadata. One input may contain several such messages.
[Replying to: ...] and [Forwarded from ...] are metadata about that message.
[Telegram content] is JSON describing non-text content. <attachments> lists saved original files with id, name, absolute path, size, and mimeType. Downloadable attachments are saved locally; some Telegram content has metadata only.
Supported images may additionally arrive as native image blocks. Inspect or process saved files with the available tools when their contents are needed.
Use send_file to upload a local file to this chat: document preserves the original file, while photo sends a Telegram-compressed image.
Reply in the user's language. Use ordinary Markdown, not Telegram-specific MarkdownV2 escaping; the channel renders supported formatting and splits long replies. Use absolute http or https URLs for Markdown links.`;
  },
);
