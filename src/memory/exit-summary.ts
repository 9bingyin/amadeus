const TOOL_RESULT_MAX_CHARS = 2_000;
export const EXIT_SUMMARY_MAX_CHARS = 80_000;
export const EXIT_SUMMARY_MIN_MESSAGES = 4;
export const EXIT_SUMMARY_SYSTEM_PROMPT = [
  "You are a session recap assistant.",
  "Read the conversation and extract key decisions, lessons learned, notes, and follow-ups.",
  "Return ONLY markdown in the specified format, without any extra commentary.",
].join("\n");

const EXIT_SUMMARY_HEADINGS = [
  "### Decisions",
  "### Lessons Learned",
  "### Notes",
  "### Follow-ups",
] as const;

export interface SerializedSessionConversation {
  messageCount: number;
  conversation: string;
}

export interface TruncatedConversation {
  text: string;
  truncated: boolean;
  totalChars: number;
}

interface SerializedSessionEntry {
  id?: string;
  parentId?: string | null;
  isMessage: boolean;
  conversationPart: string;
}

export class SessionConversationBuilder {
  readonly #entries: SerializedSessionEntry[] = [];

  pushJsonlLine(line: string): void {
    if (!line || line.includes("\r")) {
      throw new Error("Memory extraction transcript is not strict LF JSONL");
    }
    const value: unknown = JSON.parse(line);
    if (!isRecord(value) || value.type === "session") {
      return;
    }
    const id = typeof value.id === "string" ? value.id : undefined;
    const parentId =
      value.parentId === null || typeof value.parentId === "string"
        ? value.parentId
        : undefined;
    if (value.type !== "message") {
      this.#entries.push({
        ...(id ? { id } : {}),
        ...(parentId !== undefined ? { parentId } : {}),
        isMessage: false,
        conversationPart: "",
      });
      return;
    }
    if (!isRecord(value.message)) {
      throw new Error(
        "Memory extraction transcript contains an invalid message",
      );
    }
    this.#entries.push({
      ...(id ? { id } : {}),
      ...(parentId !== undefined ? { parentId } : {}),
      isMessage: true,
      conversationPart: serializeAgentMessage(value.message),
    });
  }

  finish(): SerializedSessionConversation {
    const branch = this.#activeBranch();
    return {
      messageCount: branch.filter((entry) => entry.isMessage).length,
      conversation: branch
        .map((entry) => entry.conversationPart)
        .filter(Boolean)
        .join("\n\n"),
    };
  }

  #activeBranch(): SerializedSessionEntry[] {
    if (
      this.#entries.length === 0 ||
      this.#entries.some((entry) => !entry.id)
    ) {
      return this.#entries;
    }
    const byId = new Map<string, SerializedSessionEntry>();
    for (const entry of this.#entries) {
      const id = entry.id;
      if (!id || byId.has(id)) {
        throw new Error("Memory extraction transcript has duplicate entry IDs");
      }
      byId.set(id, entry);
    }
    const branch: SerializedSessionEntry[] = [];
    const visited = new Set<string>();
    let current = this.#entries.at(-1);
    while (current) {
      const id = current.id;
      if (!id || visited.has(id)) {
        throw new Error("Memory extraction transcript branch is invalid");
      }
      visited.add(id);
      branch.push(current);
      if (current.parentId === null || current.parentId === undefined) {
        break;
      }
      current = byId.get(current.parentId);
      if (!current) {
        throw new Error("Memory extraction transcript parent is missing");
      }
    }
    return branch.reverse();
  }
}

export function serializeSessionConversation(
  strictLfJsonl: string,
): SerializedSessionConversation {
  if (!strictLfJsonl.endsWith("\n") || strictLfJsonl.includes("\r")) {
    throw new Error("Memory extraction transcript is not strict LF JSONL");
  }
  const builder = new SessionConversationBuilder();
  for (const line of strictLfJsonl.slice(0, -1).split("\n")) {
    builder.pushJsonlLine(line);
  }
  return builder.finish();
}

export function truncateConversationForSummary(
  conversationText: string,
): TruncatedConversation {
  const trimmed = conversationText.trim();
  if (!trimmed) {
    return { text: "", truncated: false, totalChars: 0 };
  }
  if (trimmed.length <= EXIT_SUMMARY_MAX_CHARS) {
    return { text: trimmed, truncated: false, totalChars: trimmed.length };
  }
  return {
    text: trimmed.slice(-EXIT_SUMMARY_MAX_CHARS),
    truncated: true,
    totalChars: trimmed.length,
  };
}

export function buildExitSummaryPrompt(
  conversationText: string,
  truncated: boolean,
  totalChars: number,
): string {
  const lines = [
    "Review the conversation and extract important decisions, lessons learned, notes, and follow-ups for a daily log.",
    "Return markdown only with these exact headings:",
    ...EXIT_SUMMARY_HEADINGS,
    'Use bullet points under each heading. If there is nothing, write "None.".',
  ];
  if (truncated) {
    lines.push(
      `Note: Conversation transcript was truncated to the most recent ${conversationText.length} of ${totalChars} characters.`,
    );
  }
  lines.push("", "<conversation>", conversationText, "</conversation>");
  return lines.join("\n");
}

export function formatExitSummaryEntry(
  summary: string,
  sessionId: string,
  timestamp: string,
): string {
  return [
    `<!-- ${timestamp} [${sessionId.slice(0, 8)}] -->`,
    "## Session Summary (auto, exit: session-end)",
    "",
    summary.trim(),
  ].join("\n");
}

export function parseExitSummary(text: string): string | null {
  const summary = text.trim();
  if (!summary) {
    return null;
  }
  const contentLines = summary
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  return contentLines.length === 0 || contentLines.every(isNoneLine)
    ? null
    : summary;
}

function serializeAgentMessage(message: Record<string, unknown>): string {
  if (message.role === "bashExecution") {
    if (message.excludeFromContext === true) {
      return "";
    }
    return `[User]: ${bashExecutionToText(message)}`;
  }
  if (message.role === "custom") {
    return serializeUserContent(message.content);
  }
  if (message.role === "branchSummary" && typeof message.summary === "string") {
    return `[User]: The following is a summary of a branch that this conversation came back from:\n\n<summary>\n${message.summary}</summary>`;
  }
  if (
    message.role === "compactionSummary" &&
    typeof message.summary === "string"
  ) {
    return `[User]: The conversation history before this point was compacted into the following summary:\n\n<summary>\n${message.summary}\n</summary>`;
  }
  if (message.role === "user") {
    return serializeUserContent(message.content);
  }
  if (message.role === "assistant") {
    return serializeAssistant(message.content);
  }
  if (message.role === "toolResult") {
    const content = contentText(message.content, "");
    return content ? `[Tool result]: ${truncateToolResult(content)}` : "";
  }
  return "";
}

function serializeUserContent(content: unknown): string {
  const text = contentText(content, "");
  return text ? `[User]: ${text}` : "";
}

function serializeAssistant(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  const thinkingParts: string[] = [];
  const toolCalls: string[] = [];
  let hasText = false;
  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== "string") {
      continue;
    }
    if (block.type === "thinking" && typeof block.thinking === "string") {
      thinkingParts.push(block.thinking);
    } else if (
      block.type === "toolCall" &&
      typeof block.name === "string" &&
      isRecord(block.arguments)
    ) {
      const args = Object.entries(block.arguments)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(", ");
      toolCalls.push(`${block.name}(${args})`);
    } else if (block.type === "text") {
      hasText = true;
    }
  }
  const parts: string[] = [];
  if (thinkingParts.length > 0) {
    parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
  }
  if (hasText) {
    parts.push(`[Assistant]: ${contentText(content)}`);
  }
  if (toolCalls.length > 0) {
    parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
  }
  return parts.join("\n\n");
}

function contentText(content: unknown, separator = "\n"): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        isRecord(block) &&
        block.type === "text" &&
        typeof block.text === "string",
    )
    .map((block) => block.text)
    .join(separator);
}

function truncateToolResult(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n\n[... ${text.length - TOOL_RESULT_MAX_CHARS} more characters truncated]`;
}

function bashExecutionToText(message: Record<string, unknown>): string {
  const command = typeof message.command === "string" ? message.command : "";
  const output = typeof message.output === "string" ? message.output : "";
  let text = `Ran \`${command}\`\n`;
  text += output ? `\`\`\`\n${output}\n\`\`\`` : "(no output)";
  if (message.cancelled === true) {
    text += "\n\n(command cancelled)";
  } else if (typeof message.exitCode === "number" && message.exitCode !== 0) {
    text += `\n\nCommand exited with code ${message.exitCode}`;
  }
  if (
    message.truncated === true &&
    typeof message.fullOutputPath === "string"
  ) {
    text += `\n\n[Output truncated. Full output: ${message.fullOutputPath}]`;
  }
  return text;
}

function isNoneLine(line: string): boolean {
  return /^none\.?$/i.test(line.replace(/^[-*+]\s*/, ""));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
