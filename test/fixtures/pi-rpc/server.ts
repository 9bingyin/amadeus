import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = Bun.argv.slice(2);
const sessionDir = argumentValue(args, "--session-dir") ?? "/tmp";
const crashAfterPrompt = args.includes("--crash-after-prompt");
await mkdir(sessionDir, { recursive: true });
let sessionNumber = 1;
let sessionId = `fake-session-${sessionNumber}`;
let sessionFile = join(sessionDir, `${sessionId}.jsonl`);
let hasAssistantEntry = false;
await writeFile(sessionFile, "", { flag: "a" });

const writer = Bun.stdout.writer();
const decoder = new TextDecoder("utf-8", { fatal: true });
const reader = Bun.stdin.stream().getReader();
let buffer = "";

while (true) {
  const result = await reader.read();
  if (result.done) {
    break;
  }
  buffer += decoder.decode(result.value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line.length > 0) {
      await handleLine(line);
    }
  }
}
buffer += decoder.decode();
if (buffer.length > 0) {
  await handleLine(buffer);
}
await writer.flush();
writer.end();

async function handleLine(line: string): Promise<void> {
  const value = JSON.parse(line) as unknown;
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("invalid command");
  }
  const id = typeof value.id === "string" ? value.id : undefined;

  switch (value.type) {
    case "get_state":
      await respond(id, value.type, {
        model: null,
        isStreaming: false,
        isCompacting: false,
        steeringMode: "all",
        followUpMode: "one-at-a-time",
        sessionFile,
        sessionId,
        pendingMessageCount: 0,
      });
      break;
    case "get_entries":
      await respond(id, value.type, {
        entries: hasAssistantEntry
          ? [
              {
                type: "message",
                id: "assistant-entry-1",
                parentId: "user-entry-1",
                message: { role: "assistant" },
              },
            ]
          : [],
        leafId: hasAssistantEntry ? "assistant-entry-1" : null,
      });
      break;
    case "set_steering_mode":
    case "abort":
      await respond(id, value.type);
      break;
    case "clear_queue":
      await respond(id, value.type, { steering: [], followUp: [] });
      break;
    case "new_session":
      sessionNumber += 1;
      sessionId = `fake-session-${sessionNumber}`;
      sessionFile = join(sessionDir, `${sessionId}.jsonl`);
      hasAssistantEntry = false;
      await writeFile(sessionFile, "", { flag: "a" });
      await respond(id, value.type, { cancelled: false });
      break;
    case "prompt":
      await respond(id, value.type);
      if (crashAfterPrompt) {
        await writer.flush();
        process.exit(7);
      }
      await output({ type: "agent_start" });
      await output({
        type: "tool_execution_start",
        toolCallId: "private-tool-call-id",
        toolName: "bash",
        args: { command: "private shell command" },
      });
      await output({
        type: "tool_execution_end",
        toolCallId: "private-tool-call-id",
        toolName: "bash",
        result: { output: "private tool output" },
        isError: false,
      });
      await output({
        type: "message_start",
        message: {
          role: "assistant",
          content: [],
          stopReason: "stop",
          timestamp: Date.now(),
        },
      });
      await output({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "fake process reply",
        },
      });
      await output({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "fake process reply" }],
          stopReason: "stop",
          timestamp: Date.now(),
        },
      });
      hasAssistantEntry = true;
      await output({ type: "agent_settled" });
      break;
    case "steer":
      await respond(id, value.type);
      break;
    case "extension_ui_response":
      break;
    default:
      await output({
        ...(id ? { id } : {}),
        type: "response",
        command: value.type,
        success: false,
        error: "unsupported command",
      });
  }
}

async function respond(
  id: string | undefined,
  command: string,
  data?: unknown,
): Promise<void> {
  await output({
    ...(id ? { id } : {}),
    type: "response",
    command,
    success: true,
    ...(data !== undefined ? { data } : {}),
  });
}

async function output(value: unknown): Promise<void> {
  writer.write(`${JSON.stringify(value)}\n`);
  await writer.flush();
}

function argumentValue(
  args: readonly string[],
  name: string,
): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
