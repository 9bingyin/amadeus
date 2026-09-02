import type {
  PiAssistantContent,
  PiAssistantMessage,
  PiAssistantMessageEvent,
  PiNonAssistantMessage,
  PiMessageRole,
  PiRpcEvent,
  PiRpcOutput,
  PiRpcResponse,
} from "./types";

export function parsePiRpcOutput(line: string): PiRpcOutput {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (error) {
    throw new Error("Pi RPC 输出不是有效 JSON", { cause: error });
  }

  const record = requireRecord(value, "Pi RPC 输出");
  const type = requireString(record.type, "Pi RPC 输出 type");

  if (type === "response") {
    return parseResponse(record);
  }

  switch (type) {
    case "agent_start":
      return { type };
    case "agent_settled":
      return { type };
    case "auto_retry_start":
      return { type };
    case "message_start":
      return {
        type,
        messageRole: parseMessageRole(record.message, "message_start.message"),
      };
    case "message_update":
      return {
        type,
        assistantMessageEvent: parseAssistantMessageEvent(
          record.assistantMessageEvent,
        ),
      };
    case "message_end":
      return { type, message: parseMessage(record.message) };
    case "tool_execution_start":
      return {
        type,
        toolCallId: requireString(record.toolCallId, "toolCallId"),
        toolName: requireString(record.toolName, "toolName"),
        args: record.args,
      };
    case "tool_execution_update":
      return {
        type,
        toolCallId: requireString(record.toolCallId, "toolCallId"),
        toolName: requireString(record.toolName, "toolName"),
        args: record.args,
        partialResult: record.partialResult,
      };
    case "tool_execution_end":
      return {
        type,
        toolCallId: requireString(record.toolCallId, "toolCallId"),
        toolName: requireString(record.toolName, "toolName"),
        result: record.result,
        isError: requireBoolean(record.isError, "isError"),
      };
    case "queue_update":
      return {
        type,
        steering: requireStringArray(record.steering, "steering"),
        followUp: requireStringArray(record.followUp, "followUp"),
      };
    case "extension_ui_request": {
      const title = optionalString(record.title, "extension_ui_request.title");
      const placeholder = optionalString(
        record.placeholder,
        "extension_ui_request.placeholder",
      );
      return {
        type,
        id: requireString(record.id, "extension_ui_request.id"),
        method: requireString(record.method, "extension_ui_request.method"),
        ...(title !== undefined ? { title } : {}),
        ...(placeholder !== undefined ? { placeholder } : {}),
        payload: record,
      };
    }
    default:
      return { type: "unhandled", eventType: type, payload: record };
  }
}

function parseAssistantMessageEvent(value: unknown): PiAssistantMessageEvent {
  const record = requireRecord(value, "message_update.assistantMessageEvent");
  const type = requireString(
    record.type,
    "message_update.assistantMessageEvent.type",
  );
  if (type !== "text_delta") {
    return { type: "other", eventType: type };
  }
  return {
    type,
    contentIndex: requireNonNegativeSafeInteger(
      record.contentIndex,
      "message_update.assistantMessageEvent.contentIndex",
    ),
    delta: requireString(
      record.delta,
      "message_update.assistantMessageEvent.delta",
    ),
  };
}

function parseMessageRole(value: unknown, path: string): PiMessageRole {
  const record = requireRecord(value, path);
  const role = requireString(record.role, `${path}.role`);
  if (role === "assistant" || isNonAssistantRole(role)) {
    return role;
  }
  throw new Error(`未知 Pi 消息角色：${role}`);
}

function parseResponse(record: Record<string, unknown>): PiRpcResponse {
  const command = requireString(record.command, "response.command");
  const success = requireBoolean(record.success, "response.success");
  const id = optionalString(record.id, "response.id");

  if (!success) {
    return {
      type: "response",
      command,
      success: false,
      error: requireString(record.error, "response.error"),
      ...(id ? { id } : {}),
    };
  }

  return {
    type: "response",
    command,
    success: true,
    ...(id ? { id } : {}),
    ...(record.data !== undefined ? { data: record.data } : {}),
  };
}

function parseMessage(
  value: unknown,
): PiAssistantMessage | PiNonAssistantMessage {
  const record = requireRecord(value, "message_end.message");
  const role = requireString(record.role, "message.role");

  if (role === "assistant") {
    const content = requireArray(record.content, "message.content").map(
      parseAssistantContent,
    );
    const stopReason = requireString(record.stopReason, "message.stopReason");
    if (!isAssistantStopReason(stopReason)) {
      throw new Error(`未知 assistant stopReason：${stopReason}`);
    }
    const errorMessage = optionalString(
      record.errorMessage,
      "message.errorMessage",
    );
    return {
      role,
      content,
      stopReason,
      ...(errorMessage ? { errorMessage } : {}),
      timestamp: requireNumber(record.timestamp, "message.timestamp"),
    };
  }

  if (!isNonAssistantRole(role)) {
    throw new Error(`未知 Pi 消息角色：${role}`);
  }
  return { role, content: record.content };
}

function parseAssistantContent(value: unknown): PiAssistantContent {
  const record = requireRecord(value, "assistant content");
  const type = requireString(record.type, "assistant content.type");

  switch (type) {
    case "text":
      return {
        type,
        text: requireString(record.text, "assistant content.text"),
      };
    case "thinking":
      return {
        type,
        thinking: requireString(record.thinking, "assistant content.thinking"),
      };
    case "toolCall":
      return {
        type,
        id: requireString(record.id, "assistant toolCall.id"),
        name: requireString(record.name, "assistant toolCall.name"),
        arguments: record.arguments,
      };
    default:
      throw new Error(`未知 assistant content 类型：${type}`);
  }
}

function isAssistantStopReason(
  value: string,
): value is PiAssistantMessage["stopReason"] {
  return ["stop", "length", "toolUse", "error", "aborted"].includes(value);
}

function isNonAssistantRole(
  value: string,
): value is PiNonAssistantMessage["role"] {
  return ["user", "toolResult", "custom", "bashExecution"].includes(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} 必须是对象`);
  }
  return Object.fromEntries(Object.entries(value));
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} 必须是数组`);
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new Error(`${path} 必须是字符串`);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : requireString(value, path);
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${path} 必须是布尔值`);
  }
  return value;
}

function requireNonNegativeSafeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path} 必须是非负安全整数`);
  }
  return value;
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} 必须是有限数字`);
  }
  return value;
}

function requireStringArray(value: unknown, path: string): string[] {
  return requireArray(value, path).map((item, index) =>
    requireString(item, `${path}[${index}]`),
  );
}
