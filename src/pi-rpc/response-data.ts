import type {
  PiRpcModelState,
  PiRpcResponse,
  PiRpcSessionState,
  PiRpcSessionStats,
} from "./types";

export function requireSuccess(
  response: PiRpcResponse,
  command: string,
): unknown {
  if (!response.success) {
    throw new Error(`Pi RPC ${command} 失败：${response.error}`);
  }
  return response.data;
}

export function parseSessionState(value: unknown): PiRpcSessionState {
  const record = requireRecord(value, "get_state.data");
  const steeringMode = requireMode(record.steeringMode, "steeringMode");
  const followUpMode = requireMode(record.followUpMode, "followUpMode");
  const sessionFile = optionalString(record.sessionFile, "sessionFile");
  const sessionName = optionalString(record.sessionName, "sessionName");
  const model = optionalModel(record.model);
  const thinkingLevel = optionalString(record.thinkingLevel, "thinkingLevel");

  return {
    ...(model !== undefined ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    isStreaming: requireBoolean(record.isStreaming, "isStreaming"),
    isCompacting: requireBoolean(record.isCompacting, "isCompacting"),
    steeringMode,
    followUpMode,
    ...(sessionFile ? { sessionFile } : {}),
    sessionId: requireString(record.sessionId, "sessionId"),
    ...(sessionName ? { sessionName } : {}),
    pendingMessageCount: requireNumber(
      record.pendingMessageCount,
      "pendingMessageCount",
    ),
  };
}

export function parseCompactionResult(value: unknown): {
  tokensBefore: number;
  estimatedTokensAfter: number;
} {
  const record = requireRecord(value, "compact.data");
  return {
    tokensBefore: requireNumber(record.tokensBefore, "compact.tokensBefore"),
    estimatedTokensAfter: requireNumber(
      record.estimatedTokensAfter,
      "compact.estimatedTokensAfter",
    ),
  };
}

export function parseSessionStats(value: unknown): PiRpcSessionStats {
  const record = requireRecord(value, "get_session_stats.data");
  const sessionId = requireString(
    record.sessionId,
    "get_session_stats.sessionId",
  );
  if (record.contextUsage === undefined) {
    return { sessionId };
  }

  const context = requireRecord(
    record.contextUsage,
    "get_session_stats.contextUsage",
  );
  const contextWindow = requireNumber(
    context.contextWindow,
    "get_session_stats.contextUsage.contextWindow",
  );
  if (contextWindow === 0) {
    throw new Error(
      "Pi RPC get_session_stats.contextUsage.contextWindow 必须大于零",
    );
  }

  return {
    sessionId,
    contextUsage: {
      tokens: requireNullableNumber(
        context.tokens,
        "get_session_stats.contextUsage.tokens",
      ),
      contextWindow,
      percent: requireNullableFiniteNumber(
        context.percent,
        "get_session_stats.contextUsage.percent",
      ),
    },
  };
}

export function parseNewSessionResult(value: unknown): { cancelled: boolean } {
  const record = requireRecord(value, "new_session.data");
  return {
    cancelled: requireBoolean(record.cancelled, "new_session.cancelled"),
  };
}

export function parseClearedQueue(value: unknown): {
  steering: string[];
  followUp: string[];
} {
  const record = requireRecord(value, "clear_queue.data");
  return {
    steering: requireStringArray(record.steering, "clear_queue.steering"),
    followUp: requireStringArray(record.followUp, "clear_queue.followUp"),
  };
}

export function parseLatestAssistantEntryId(value: unknown): string {
  const data = requireRecord(value, "get_entries.data");
  if (!Array.isArray(data.entries)) {
    throw new Error("Pi get_entries 缺少 entries");
  }

  for (let index = data.entries.length - 1; index >= 0; index -= 1) {
    const entry: unknown = data.entries[index];
    if (
      !isRecord(entry) ||
      entry.type !== "message" ||
      typeof entry.id !== "string"
    ) {
      continue;
    }
    if (isRecord(entry.message) && entry.message.role === "assistant") {
      return entry.id;
    }
  }
  throw new Error("Pi session 中找不到最终 assistant entry");
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Pi RPC ${path} 必须是对象`);
  }
  return Object.fromEntries(Object.entries(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireMode(value: unknown, path: string): "all" | "one-at-a-time" {
  if (value !== "all" && value !== "one-at-a-time") {
    throw new Error(`Pi RPC ${path} 无效`);
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Pi RPC ${path} 必须是非空字符串`);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : requireString(value, path);
}

function optionalModel(value: unknown): PiRpcModelState | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  const record = requireRecord(value, "get_state.model");
  return {
    provider: requireString(record.provider, "get_state.model.provider"),
    id: requireString(record.id, "get_state.model.id"),
  };
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Pi RPC ${path} 必须是布尔值`);
  }
  return value;
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Pi RPC ${path} 必须是数组`);
  }
  return value.map((item, index) => requireString(item, `${path}[${index}]`));
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Pi RPC ${path} 必须是非负整数`);
  }
  return value;
}

function requireNullableNumber(value: unknown, path: string): number | null {
  return value === null ? null : requireNumber(value, path);
}

function requireNullableFiniteNumber(
  value: unknown,
  path: string,
): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Pi RPC ${path} 必须是非负有限数字或 null`);
  }
  return value;
}
