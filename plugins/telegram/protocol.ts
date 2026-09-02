export const TELEGRAM_OUTBOUND_PROTOCOL_TITLE = "amadeus.telegram.v1";
export const TELEGRAM_OUTBOUND_RESPONSE_TIMEOUT_MS = 130_000;

export const TELEGRAM_OUTBOUND_TOOL_NAMES = [
  "telegram_send_document",
  "telegram_send_photo",
] as const;

export type TelegramOutboundToolName =
  (typeof TELEGRAM_OUTBOUND_TOOL_NAMES)[number];

export type TelegramOutboundKind = "document" | "photo";

export interface TelegramOutboundFileArgs {
  path: string;
  caption?: string;
}

export type TelegramOutboundResult =
  | {
      version: 1;
      status: "sent";
      kind: TelegramOutboundKind;
      messageId: number;
      indexed: true;
      fileName: string;
      size: number;
      mimeType: string;
    }
  | {
      version: 1;
      status: "rejected";
      code: string;
      message: string;
    }
  | {
      version: 1;
      status: "unknown";
      code: string;
      message: string;
      telegramSent?: true;
      messageId?: number;
    };

export function isTelegramOutboundToolName(
  value: string,
): value is TelegramOutboundToolName {
  return TELEGRAM_OUTBOUND_TOOL_NAMES.some((name) => name === value);
}

export function telegramOutboundKind(
  toolName: TelegramOutboundToolName,
): TelegramOutboundKind {
  return toolName === "telegram_send_document" ? "document" : "photo";
}

export function parseTelegramOutboundFileArgs(
  value: unknown,
): TelegramOutboundFileArgs {
  const record = requireRecord(value, "Telegram tool arguments");
  const unknownKeys = Object.keys(record).filter(
    (key) => key !== "path" && key !== "caption",
  );
  if (unknownKeys.length > 0) {
    throw new Error("Telegram tool arguments contain unknown fields");
  }

  const path = requireString(record.path, "path");
  const caption = optionalString(record.caption, "caption");
  if (caption !== undefined && caption.length > 1024) {
    throw new Error("caption exceeds 1024 UTF-16 units");
  }
  return { path, ...(caption !== undefined ? { caption } : {}) };
}

export function parseTelegramOutboundResult(
  text: string,
): TelegramOutboundResult {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error("Amadeus returned invalid Telegram tool JSON", {
      cause: error,
    });
  }

  const record = requireRecord(value, "Telegram tool result");
  if (record.version !== 1) {
    throw new Error("Amadeus returned an unsupported Telegram tool version");
  }
  const status = requireString(record.status, "status");

  if (status === "sent") {
    const kind = requireKind(record.kind);
    const indexed = requireBoolean(record.indexed, "indexed");
    if (!indexed) {
      throw new Error("A sent Telegram tool result must be indexed");
    }
    return {
      version: 1,
      status,
      kind,
      messageId: requirePositiveSafeInteger(record.messageId, "messageId"),
      indexed,
      fileName: requireString(record.fileName, "fileName"),
      size: requireNonNegativeSafeInteger(record.size, "size"),
      mimeType: requireString(record.mimeType, "mimeType"),
    };
  }

  if (status === "rejected") {
    return {
      version: 1,
      status,
      code: requireString(record.code, "code"),
      message: requireString(record.message, "message"),
    };
  }

  if (status === "unknown") {
    const telegramSent = record.telegramSent;
    if (telegramSent !== undefined && telegramSent !== true) {
      throw new Error("telegramSent must be true when present");
    }
    const messageId =
      record.messageId === undefined
        ? undefined
        : requirePositiveSafeInteger(record.messageId, "messageId");
    if ((telegramSent === true) !== (messageId !== undefined)) {
      throw new Error("telegramSent and messageId must be provided together");
    }
    return {
      version: 1,
      status,
      code: requireString(record.code, "code"),
      message: requireString(record.message, "message"),
      ...(telegramSent === true ? { telegramSent } : {}),
      ...(messageId !== undefined ? { messageId } : {}),
    };
  }

  throw new Error("Amadeus returned an unknown Telegram tool status");
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : requireString(value, path);
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean`);
  }
  return value;
}

function requirePositiveSafeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive safe integer`);
  }
  return value;
}

function requireNonNegativeSafeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative safe integer`);
  }
  return value;
}

function requireKind(value: unknown): TelegramOutboundKind {
  if (value === "document" || value === "photo") {
    return value;
  }
  throw new Error("kind must be document or photo");
}
