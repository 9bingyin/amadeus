export const MEMORY_PROTOCOL_TITLE = "amadeus.memory.v1";
export const MEMORY_SNAPSHOT_RESPONSE_TIMEOUT_MS = 1_000;
export const MEMORY_TOOL_RESPONSE_TIMEOUT_MS = 65_000;
export const MEMORY_SNAPSHOT_MAX_CHARS = 16_000;
export const MEMORY_CONTENT_MAX_CHARS = 64 * 1024;

export const MEMORY_TOOL_NAMES = [
  "memory_write",
  "memory_forget",
  "memory_restore",
  "memory_read",
  "memory_search",
  "memory_status",
  "scratchpad",
] as const;

export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number];
export type MemoryWriteTarget = "long_term" | "daily";
export type MemorySearchMode = "keyword" | "semantic" | "deep";

export type MemoryToolArguments =
  | {
      toolName: "memory_write";
      target: MemoryWriteTarget;
      content: string;
      mode?: "append" | "overwrite";
    }
  | {
      toolName: "memory_forget";
      match: string;
      target?: MemoryWriteTarget;
      date?: string;
    }
  | { toolName: "memory_restore"; recoveryId: string }
  | {
      toolName: "memory_read";
      target: "long_term" | "scratchpad" | "daily" | "list";
      date?: string;
    }
  | {
      toolName: "memory_search";
      query: string;
      mode?: MemorySearchMode;
      limit?: number;
    }
  | { toolName: "memory_status" }
  | {
      toolName: "scratchpad";
      action: "add" | "done" | "undo" | "clear_done" | "list";
      text?: string;
    };

export type MemoryUiRequest =
  | { version: 1; type: "snapshot_get" }
  | {
      version: 1;
      type: "tool_execute";
      toolCallId: string;
      toolName: MemoryToolName;
      args: unknown;
    };

export type MemorySnapshotResult =
  | {
      version: 1;
      status: "ready";
      revision: number;
      content: string;
    }
  | { version: 1; status: "unavailable"; code: string };

export type MemoryToolResult =
  | {
      version: 1;
      status: "completed";
      receiptId: string;
      content: string;
      isError?: true;
    }
  | { version: 1; status: "rejected"; code: string; message: string }
  | {
      version: 1;
      status: "unknown";
      code: string;
      message: string;
      committed?: true;
      receiptId?: string;
    };

export function isMemoryToolName(value: string): value is MemoryToolName {
  return MEMORY_TOOL_NAMES.some((name) => name === value);
}

export function encodeMemoryUiRequest(request: MemoryUiRequest): string {
  return JSON.stringify(request);
}

export function parseMemoryUiRequest(value: string): MemoryUiRequest {
  const record = parseJsonRecord(value, "Memory UI request");
  assertOnlyKeys(
    record,
    ["version", "type", "toolCallId", "toolName", "args"],
    "Memory UI request",
  );
  if (record.version !== 1) {
    throw new Error("Memory UI request has an unsupported version");
  }
  if (record.type === "snapshot_get") {
    if (
      record.toolCallId !== undefined ||
      record.toolName !== undefined ||
      record.args !== undefined
    ) {
      throw new Error("snapshot_get must not contain tool fields");
    }
    return { version: 1, type: "snapshot_get" };
  }
  if (record.type === "tool_execute") {
    return {
      version: 1,
      type: "tool_execute",
      toolCallId: requireBoundedString(record.toolCallId, "toolCallId", 4_096),
      toolName: requireEnum(record.toolName, MEMORY_TOOL_NAMES, "toolName"),
      args: requireRecord(record.args, "args"),
    };
  }
  throw new Error("Memory UI request has an unknown type");
}

export function parseMemoryToolArguments(
  toolName: MemoryToolName,
  value: unknown,
): MemoryToolArguments {
  const record = requireRecord(value, `${toolName} arguments`);
  switch (toolName) {
    case "memory_write": {
      assertOnlyKeys(record, ["target", "content", "mode"], toolName);
      const target = requireEnum(
        record.target,
        ["long_term", "daily"],
        "target",
      );
      const mode = optionalEnum(record.mode, ["append", "overwrite"], "mode");
      return {
        toolName,
        target,
        content: requireBoundedString(
          record.content,
          "content",
          MEMORY_CONTENT_MAX_CHARS,
          true,
        ),
        ...(mode ? { mode } : {}),
      };
    }
    case "memory_forget": {
      assertOnlyKeys(record, ["match", "target", "date"], toolName);
      const target = optionalEnum(
        record.target,
        ["long_term", "daily"],
        "target",
      );
      const date = optionalDate(record.date);
      return {
        toolName,
        match: requireBoundedString(record.match, "match", 4_096),
        ...(target ? { target } : {}),
        ...(date ? { date } : {}),
      };
    }
    case "memory_restore":
      assertOnlyKeys(record, ["recoveryId"], toolName);
      return {
        toolName,
        recoveryId: requireIdentifier(record.recoveryId, "recoveryId"),
      };
    case "memory_read": {
      assertOnlyKeys(record, ["target", "date"], toolName);
      const target = requireEnum(
        record.target,
        ["long_term", "scratchpad", "daily", "list"],
        "target",
      );
      const date = optionalReadDate(record.date, target);
      return {
        toolName,
        target,
        ...(date !== undefined ? { date } : {}),
      };
    }
    case "memory_search": {
      assertOnlyKeys(record, ["query", "mode", "limit"], toolName);
      const mode = optionalEnum(
        record.mode,
        ["keyword", "semantic", "deep"],
        "mode",
      );
      const limit = optionalInteger(record.limit, "limit", 1, 20);
      return {
        toolName,
        query: requireBoundedString(record.query, "query", 4_096),
        ...(mode ? { mode } : {}),
        ...(limit !== undefined ? { limit } : {}),
      };
    }
    case "memory_status":
      assertOnlyKeys(record, [], toolName);
      return { toolName };
    case "scratchpad": {
      assertOnlyKeys(record, ["action", "text"], toolName);
      const action = requireEnum(
        record.action,
        ["add", "done", "undo", "clear_done", "list"],
        "action",
      );
      const text = optionalBoundedString(record.text, "text", 4_096);
      return { toolName, action, ...(text ? { text } : {}) };
    }
  }
}

export function parseMemorySnapshotResult(text: string): MemorySnapshotResult {
  const record = parseJsonRecord(text, "Memory snapshot result");
  requireVersion(record.version, "Memory snapshot result");
  if (record.status === "ready") {
    assertOnlyKeys(
      record,
      ["version", "status", "revision", "content"],
      "Memory snapshot result",
    );
    return {
      version: 1,
      status: "ready",
      revision: requireInteger(record.revision, "revision", 0),
      content: requireBoundedString(
        record.content,
        "content",
        MEMORY_SNAPSHOT_MAX_CHARS,
        true,
      ),
    };
  }
  if (record.status === "unavailable") {
    assertOnlyKeys(
      record,
      ["version", "status", "code"],
      "Memory snapshot result",
    );
    return {
      version: 1,
      status: "unavailable",
      code: requireIdentifier(record.code, "code"),
    };
  }
  throw new Error("Memory snapshot result has an unknown status");
}

export function parseMemoryToolResult(text: string): MemoryToolResult {
  const record = parseJsonRecord(text, "Memory tool result");
  requireVersion(record.version, "Memory tool result");
  if (record.status === "completed") {
    assertOnlyKeys(
      record,
      ["version", "status", "receiptId", "content", "isError"],
      "Memory tool result",
    );
    if (record.isError !== undefined && record.isError !== true) {
      throw new Error("isError must be true when present");
    }
    return {
      version: 1,
      status: "completed",
      receiptId: requireOpaqueId(record.receiptId, "receiptId"),
      content: requireBoundedString(
        record.content,
        "content",
        MEMORY_CONTENT_MAX_CHARS,
        true,
      ),
      ...(record.isError === true ? { isError: true } : {}),
    };
  }
  if (record.status === "rejected") {
    assertOnlyKeys(
      record,
      ["version", "status", "code", "message"],
      "Memory tool result",
    );
    return {
      version: 1,
      status: "rejected",
      code: requireIdentifier(record.code, "code"),
      message: requireBoundedString(record.message, "message", 4_096),
    };
  }
  if (record.status === "unknown") {
    assertOnlyKeys(
      record,
      ["version", "status", "code", "message", "committed", "receiptId"],
      "Memory tool result",
    );
    if (record.committed !== undefined && record.committed !== true) {
      throw new Error("committed must be true when present");
    }
    const receiptId =
      record.receiptId === undefined
        ? undefined
        : requireOpaqueId(record.receiptId, "receiptId");
    if ((record.committed === true) !== (receiptId !== undefined)) {
      throw new Error("committed and receiptId must be provided together");
    }
    return {
      version: 1,
      status: "unknown",
      code: requireIdentifier(record.code, "code"),
      message: requireBoundedString(record.message, "message", 4_096),
      ...(record.committed === true ? { committed: true } : {}),
      ...(receiptId ? { receiptId } : {}),
    };
  }
  throw new Error("Memory tool result has an unknown status");
}

function parseJsonRecord(text: string, path: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${path} is not valid JSON`, { cause: error });
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
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${path} contains unknown fields: ${unknown.join(", ")}`);
  }
}

function requireVersion(value: unknown, path: string): void {
  if (value !== 1) {
    throw new Error(`${path} has an unsupported version`);
  }
}

function requireBoundedString(
  value: unknown,
  path: string,
  maxLength: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.trim().length === 0) ||
    value.length > maxLength
  ) {
    throw new Error(
      `${path} must be a string of at most ${maxLength} characters`,
    );
  }
  return value;
}

function optionalBoundedString(
  value: unknown,
  path: string,
  maxLength: number,
): string | undefined {
  return value === undefined
    ? undefined
    : requireBoundedString(value, path, maxLength);
}

function requireIdentifier(value: unknown, path: string): string {
  const text = requireBoundedString(value, path, 256);
  if (!/^[A-Za-z0-9_.:@/-]+$/.test(text)) {
    throw new Error(`${path} contains unsupported characters`);
  }
  return text;
}

function requireOpaqueId(value: unknown, path: string): string {
  return requireBoundedString(value, path, 8_192);
}

function optionalReadDate(
  value: unknown,
  target: "long_term" | "scratchpad" | "daily" | "list",
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length > 10) {
    throw new Error("date must be a string of at most 10 characters");
  }
  if (target !== "daily") {
    return undefined;
  }
  if (value === "") {
    return value;
  }
  return optionalDate(value);
}

function optionalDate(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const date = requireBoundedString(value, "date", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("date must use YYYY-MM-DD");
  }
  return date;
}

function requireEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  path: string,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${path} has an unsupported value`);
  }
  return value;
}

function optionalEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  path: string,
): Values[number] | undefined {
  return value === undefined ? undefined : requireEnum(value, values, path);
}

function requireInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${path} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function optionalInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number | undefined {
  return value === undefined
    ? undefined
    : requireInteger(value, path, minimum, maximum);
}
