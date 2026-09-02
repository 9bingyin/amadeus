import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  parseTelegramOutboundResult,
  TELEGRAM_OUTBOUND_PROTOCOL_TITLE,
  TELEGRAM_OUTBOUND_RESPONSE_TIMEOUT_MS,
  type TelegramOutboundKind,
} from "./protocol";

const fileParameters = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      description:
        "Path to an existing local file. Relative paths are resolved from the current working directory.",
    }),
    caption: Type.Optional(
      Type.String({
        maxLength: 1024,
        description: "Optional plain-text Telegram caption.",
      }),
    ),
  },
  { additionalProperties: false },
);

const documentTool = {
  name: "telegram_send_document",
  label: "Send Telegram document",
  description:
    "Send an existing local file to the current Telegram chat as a document. Use only when the user explicitly asks to receive the file. The path must identify a local file, not a URL.",
  promptSnippet: "Send a local file to the current Telegram chat as a document",
  promptGuidelines: [
    "Use telegram_send_document only when the user explicitly asks to receive an existing local file.",
    "Never retry telegram_send_document automatically when its result is unknown or says the file was already sent.",
  ],
  parameters: fileParameters,
  executionMode: "sequential",
  async execute(toolCallId, _params, _signal, _onUpdate, ctx) {
    return await executeTelegramSend(toolCallId, "document", ctx);
  },
} satisfies Parameters<ExtensionAPI["registerTool"]>[0];

const photoTool = {
  name: "telegram_send_photo",
  label: "Send Telegram photo",
  description:
    "Send an existing local image to the current Telegram chat as a photo preview. Use only when the user explicitly asks to receive or view the image. The path must identify a local file, not a URL.",
  promptSnippet: "Send a local image to the current Telegram chat as a photo",
  promptGuidelines: [
    "Use telegram_send_photo only when the user explicitly asks to receive or view an existing local image.",
    "Never retry telegram_send_photo automatically when its result is unknown or says the photo was already sent.",
  ],
  parameters: fileParameters,
  executionMode: "sequential",
  async execute(toolCallId, _params, _signal, _onUpdate, ctx) {
    return await executeTelegramSend(toolCallId, "photo", ctx);
  },
} satisfies Parameters<ExtensionAPI["registerTool"]>[0];

export const telegramOutboundTools = [documentTool, photoTool] as const;

export default function telegramOutboundExtension(pi: ExtensionAPI): void {
  for (const tool of telegramOutboundTools) {
    pi.registerTool(tool);
  }
}

async function executeTelegramSend(
  toolCallId: string,
  expectedKind: TelegramOutboundKind,
  ctx: ExtensionContext,
) {
  if (ctx.mode !== "rpc") {
    throw new Error("Telegram delivery is available only through Amadeus RPC");
  }

  const response = await ctx.ui.input(
    TELEGRAM_OUTBOUND_PROTOCOL_TITLE,
    toolCallId,
    { timeout: TELEGRAM_OUTBOUND_RESPONSE_TIMEOUT_MS },
  );
  if (response === undefined) {
    throw new Error(
      "Amadeus did not return a Telegram delivery result. Do not retry automatically.",
    );
  }

  const result = parseTelegramOutboundResult(response);
  if (result.status === "rejected") {
    throw new Error(`Telegram delivery rejected: ${result.message}`);
  }
  if (result.status === "unknown") {
    if (result.telegramSent) {
      throw new Error(
        `Telegram sent the file as message ${result.messageId}, but the operation did not complete: ${result.message}. Do not retry automatically.`,
      );
    }
    throw new Error(
      `Telegram delivery outcome is unknown: ${result.message}. Do not retry automatically.`,
    );
  }
  if (result.kind !== expectedKind) {
    throw new Error("Amadeus returned a mismatched Telegram delivery kind");
  }

  const noun = result.kind === "document" ? "document" : "photo";
  const text = `Telegram ${noun} sent successfully as message ${result.messageId}.`;

  return {
    content: [{ type: "text" as const, text }],
    details: result,
  };
}
