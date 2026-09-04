// Verbatim exit-summary behavior extracted from pi-memory 0.4.2,
// commit 39e6b998a2279c8fad4a2c6c64e26828c1d6023e.
export const BASELINE_EXIT_SUMMARY_MAX_CHARS = 80_000;
export const BASELINE_EXIT_SUMMARY_MIN_MESSAGES = 4;
export const BASELINE_EXIT_SUMMARY_SYSTEM_PROMPT = [
  "You are a session recap assistant.",
  "Read the conversation and extract key decisions, lessons learned, notes, and follow-ups.",
  "Return ONLY markdown in the specified format, without any extra commentary.",
].join("\n");

export function baselineTruncateConversationForSummary(
  conversationText: string,
): { text: string; truncated: boolean; totalChars: number } {
  const trimmed = conversationText.trim();
  if (!trimmed) {
    return { text: "", truncated: false, totalChars: 0 };
  }
  const truncated = baselineTruncateText(
    trimmed,
    BASELINE_EXIT_SUMMARY_MAX_CHARS,
  );
  return {
    text: truncated.text,
    truncated: truncated.truncated,
    totalChars: trimmed.length,
  };
}

export function baselineBuildExitSummaryPrompt(
  conversationText: string,
  truncated: boolean,
  totalChars: number,
): string {
  const lines = [
    "Review the conversation and extract important decisions, lessons learned, notes, and follow-ups for a daily log.",
    "Return markdown only with these exact headings:",
    "### Decisions",
    "### Lessons Learned",
    "### Notes",
    "### Follow-ups",
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

export function baselineFormatExitSummaryEntry(
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

export function baselineIsExitSummaryEmpty(summary: string): boolean {
  const contentLines = summary
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (contentLines.length === 0) {
    return true;
  }
  return contentLines.every((line) =>
    /^none\.?$/i.test(line.replace(/^[-*+]\s*/, "")),
  );
}

function baselineTruncateText(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (maxChars <= 0 || text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: text.slice(-maxChars), truncated: true };
}
