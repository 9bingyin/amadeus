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

export interface TelegramOutboundUiRequest {
  version: 1;
  type: "send";
  toolCallId: string;
  toolName: TelegramOutboundToolName;
  args: unknown;
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

export function encodeTelegramOutboundUiRequest(
  request: TelegramOutboundUiRequest,
): string {
  return JSON.stringify(request);
}

export function parseTelegramOutboundUiRequest(
  text: string,
): TelegramOutboundUiRequest {
  const record = parseJsonRecord(
    text,
    "Telegram UI request",
    "Telegram UI request is not valid JSON",
  );
  assertOnlyKeys(
    record,
    ["version", "type", "toolCallId", "toolName", "args"],
    "Telegram UI request",
  );
  if (record.version !== 1 || record.type !== "send") {
    throw new Error("Telegram UI request has an unsupported version or type");
  }
  const toolName = requireToolName(record.toolName);
  return {
    version: 1,
    type: "send",
    toolCallId: requireBoundedString(record.toolCallId, "toolCallId", 4_096),
    toolName,
    args: requireRecord(record.args, "args"),
  };
}

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
  assertOnlyKeys(record, ["path", "caption"], "Telegram tool arguments");

  const path = requireString(record.path, "path");
  const caption = optionalString(record.caption, "caption");
  if (caption !== undefined && caption.length > 1024) {
    throw new Error("caption exceeds 1024 UTF-16 units");
  }
  return {
    path,
    ...(caption !== undefined && caption.length > 0 ? { caption } : {}),
  };
}

export function parseTelegramOutboundResult(
  text: string,
): TelegramOutboundResult {
  const record = parseJsonRecord(
    text,
    "Telegram tool result",
    "Amadeus returned invalid Telegram tool JSON",
  );
  if (record.version !== 1) {
    throw new Error("Amadeus returned an unsupported Telegram tool version");
  }
  const status = requireString(record.status, "status");

  if (status === "sent") {
    assertOnlyKeys(
      record,
      [
        "version",
        "status",
        "kind",
        "messageId",
        "indexed",
        "fileName",
        "size",
        "mimeType",
      ],
      "Telegram tool result",
    );
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
      fileName: requireBoundedString(record.fileName, "fileName", 1_024),
      size: requireNonNegativeSafeInteger(record.size, "size"),
      mimeType: requireBoundedString(record.mimeType, "mimeType", 256),
    };
  }

  if (status === "rejected") {
    assertOnlyKeys(
      record,
      ["version", "status", "code", "message"],
      "Telegram tool result",
    );
    return {
      version: 1,
      status,
      code: requireBoundedString(record.code, "code", 256),
      message: requireBoundedString(record.message, "message", 4_096),
    };
  }

  if (status === "unknown") {
    assertOnlyKeys(
      record,
      ["version", "status", "code", "message", "telegramSent", "messageId"],
      "Telegram tool result",
    );
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
      code: requireBoundedString(record.code, "code", 256),
      message: requireBoundedString(record.message, "message", 4_096),
      ...(telegramSent === true ? { telegramSent } : {}),
      ...(messageId !== undefined ? { messageId } : {}),
    };
  }

  throw new Error("Amadeus returned an unknown Telegram tool status");
}

function parseJsonRecord(
  text: string,
  path: string,
  errorMessage: string,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(errorMessage, { cause: error });
  }
  return requireRecord(value, path);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error(`${path} contains unknown fields`);
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === "") {
    return value;
  }
  return requireString(value, path);
}

function requireBoundedString(
  value: unknown,
  path: string,
  maxLength: number,
): string {
  const text = requireString(value, path);
  if (text.length > maxLength) {
    throw new Error(`${path} exceeds ${maxLength} UTF-16 units`);
  }
  return text;
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

function requireToolName(value: unknown): TelegramOutboundToolName {
  if (typeof value === "string" && isTelegramOutboundToolName(value)) {
    return value;
  }
  throw new Error("toolName is not a Telegram outbound tool");
}

function requireKind(value: unknown): TelegramOutboundKind {
  if (value === "document" || value === "photo") {
    return value;
  }
  throw new Error("kind must be document or photo");
}
