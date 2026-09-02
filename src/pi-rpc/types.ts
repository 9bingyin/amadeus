export interface PiRpcImage {
  type: "image";
  data: string;
  mimeType: string;
}

interface PiRpcCommandBase {
  id: string;
}

export type PiRpcCommand =
  | (PiRpcCommandBase & {
      type: "prompt";
      message: string;
      images?: PiRpcImage[];
      streamingBehavior?: "steer" | "followUp";
    })
  | (PiRpcCommandBase & {
      type: "steer";
      message: string;
      images?: PiRpcImage[];
    })
  | (PiRpcCommandBase & { type: "abort" })
  | (PiRpcCommandBase & { type: "clear_queue" })
  | (PiRpcCommandBase & { type: "new_session"; parentSession?: string })
  | (PiRpcCommandBase & { type: "get_state" })
  | (PiRpcCommandBase & { type: "get_session_stats" })
  | (PiRpcCommandBase & { type: "compact" })
  | (PiRpcCommandBase & { type: "get_entries"; since?: string })
  | (PiRpcCommandBase & {
      type: "set_steering_mode";
      mode: "all" | "one-at-a-time";
    });

export type PiRpcCommandRequest = PiRpcCommand extends infer Command
  ? Command extends PiRpcCommandBase
    ? Omit<Command, "id">
    : never
  : never;

export type PiRpcExtensionUiResponse =
  | {
      type: "extension_ui_response";
      id: string;
      cancelled: true;
    }
  | {
      type: "extension_ui_response";
      id: string;
      value: string;
    };

export interface PiRpcModelState {
  provider: string;
  id: string;
}

export interface PiRpcSessionState {
  model?: PiRpcModelState | null;
  thinkingLevel?: string;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  pendingMessageCount: number;
}

export interface PiRpcContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface PiRpcSessionStats {
  sessionId: string;
  contextUsage?: PiRpcContextUsage;
}

export type PiRpcResponse =
  | {
      id?: string;
      type: "response";
      command: string;
      success: false;
      error: string;
    }
  | {
      id?: string;
      type: "response";
      command: string;
      success: true;
      data?: unknown;
    };

export type PiAssistantContent =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown };

export interface PiAssistantMessage {
  role: "assistant";
  content: PiAssistantContent[];
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}

export interface PiNonAssistantMessage {
  role: "user" | "toolResult" | "custom" | "bashExecution";
  content: unknown;
}

export type PiMessageRole =
  PiAssistantMessage["role"] | PiNonAssistantMessage["role"];

export type PiAssistantMessageEvent =
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "other"; eventType: string };

export type PiRpcEvent =
  | { type: "agent_start" }
  | { type: "agent_settled" }
  | { type: "auto_retry_start" }
  | { type: "message_start"; messageRole: PiMessageRole }
  | {
      type: "message_update";
      assistantMessageEvent: PiAssistantMessageEvent;
    }
  | { type: "message_end"; message: PiAssistantMessage | PiNonAssistantMessage }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | {
      type: "extension_ui_request";
      id: string;
      method: string;
      title?: string;
      placeholder?: string;
      payload: Record<string, unknown>;
    }
  | { type: "unhandled"; eventType: string; payload: Record<string, unknown> };

export type PiRpcOutput = PiRpcResponse | PiRpcEvent;
