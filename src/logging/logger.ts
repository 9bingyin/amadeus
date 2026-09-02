import { createHash } from "node:crypto";
import { LOG_FIELD_NAMES, type LogEvent, type LogEventFields } from "./events";

const MAX_STRING_LENGTH = 256;
const SAFE_ERROR_NAMES = new Set([
  "AbortError",
  "AggregateError",
  "BotError",
  "DOMException",
  "Error",
  "EvalError",
  "FetchError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TelegramDownloadError",
  "TypeError",
  "URIError",
  "UnresolvableTelegramReplyError",
  "UnknownError",
  "ZodError",
]);
const SAFE_TOOL_NAMES = new Set([
  "Agent",
  "SubagentWorkflow",
  "ask_user_question",
  "bash",
  "bg_task",
  "create_goal",
  "edit",
  "find",
  "get_goal",
  "get_subagent_result",
  "grep",
  "ls",
  "read",
  "set_goal_tasks",
  "steer_subagent",
  "todo",
  "update_goal",
  "update_goal_task",
  "write",
]);

export interface InfoLogger {
  info<Event extends LogEvent>(
    event: Event,
    fields: Readonly<LogEventFields[Event]>,
  ): void;
}

export const noopInfoLogger: InfoLogger = {
  info() {},
};

export interface InfoLoggerOptions {
  now?: () => Date;
  writeLine?: (line: string) => void;
}

export function createInfoLogger(options: InfoLoggerOptions = {}): InfoLogger {
  const now = options.now ?? (() => new Date());
  const writeLine =
    options.writeLine ?? ((line: string) => process.stdout.write(`${line}\n`));

  return {
    info(event, fields) {
      try {
        writeLine(formatInfoLog(event, fields, now()));
      } catch {
        // Logging must never affect application control flow.
      }
    },
  };
}

export function formatInfoLog<Event extends LogEvent>(
  event: Event,
  fields: Readonly<LogEventFields[Event]>,
  time: Date,
): string {
  const parts = [`time=${time.toISOString()}`, "level=info", `event=${event}`];

  for (const key of [...LOG_FIELD_NAMES[event]].sort()) {
    const value: unknown = Reflect.get(fields, key);
    if (value === undefined) {
      continue;
    }
    parts.push(`${key}=${formatValue(key, value)}`);
  }
  return parts.join(" ");
}

export function errorName(error: unknown): string {
  if (!(error instanceof Error)) {
    return "UnknownError";
  }
  try {
    const name: unknown = error.name;
    return typeof name === "string" && SAFE_ERROR_NAMES.has(name)
      ? name
      : "UnknownError";
  } catch {
    return "UnknownError";
  }
}

function formatValue(key: string, value: unknown): string {
  if (typeof value === "string") {
    if (key === "file_unique_id" || key === "tool_call_id") {
      return encodeString(fingerprint(value));
    }
    if (key === "tool_name" && !SAFE_TOOL_NAMES.has(value)) {
      return encodeString(fingerprint(value));
    }
    const shortened = Array.from(value).slice(0, MAX_STRING_LENGTH).join("");
    return encodeString(shortened);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  throw new Error(
    "Info log fields must contain only strings, finite numbers, or booleans",
  );
}

function encodeString(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function fingerprint(value: string): string {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `sha256:${digest}`;
}
