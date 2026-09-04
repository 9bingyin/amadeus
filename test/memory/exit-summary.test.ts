import { describe, expect, test } from "bun:test";
import {
  convertToLlm,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildExitSummaryPrompt,
  EXIT_SUMMARY_MAX_CHARS,
  EXIT_SUMMARY_MIN_MESSAGES,
  EXIT_SUMMARY_SYSTEM_PROMPT,
  formatExitSummaryEntry,
  parseExitSummary,
  serializeSessionConversation,
  truncateConversationForSummary,
} from "../../src/memory/exit-summary";
import {
  baselineBuildExitSummaryPrompt,
  BASELINE_EXIT_SUMMARY_MAX_CHARS,
  BASELINE_EXIT_SUMMARY_MIN_MESSAGES,
  BASELINE_EXIT_SUMMARY_SYSTEM_PROMPT,
  baselineFormatExitSummaryEntry,
  baselineIsExitSummaryEmpty,
  baselineTruncateConversationForSummary,
} from "../fixtures/pi-memory-0.4.2-baseline";

const SANITIZED_CONVERSATION = [
  "[User]: Summarize the release notes.",
  "[Assistant thinking]: Read the source first.",
  '[Assistant tool calls]: fetch_page(url="https://example.invalid/release")',
  "[Tool result]: Version 2 reduces memory use.",
  "[Assistant]: Version 2 mainly reduces memory use.",
].join("\n\n");

const SUMMARY = [
  "### Decisions",
  "- Ship version 2.",
  "### Lessons Learned",
  "None.",
  "### Notes",
  "- Memory use decreased.",
  "### Follow-ups",
  "- Verify production metrics.",
].join("\n");

describe("pi-memory 0.4.2 exit summary contract", () => {
  test("固定常量与 commit 基线一致", () => {
    expect(EXIT_SUMMARY_MAX_CHARS).toBe(BASELINE_EXIT_SUMMARY_MAX_CHARS);
    expect(EXIT_SUMMARY_MIN_MESSAGES).toBe(BASELINE_EXIT_SUMMARY_MIN_MESSAGES);
    expect(EXIT_SUMMARY_SYSTEM_PROMPT).toBe(
      BASELINE_EXIT_SUMMARY_SYSTEM_PROMPT,
    );
  });

  test("convertToLlm 和 serializeConversation 语义包含 tool call/result", async () => {
    const path = fileURLToPath(
      new URL("../fixtures/memory-exit-summary/session.jsonl", import.meta.url),
    );
    const serialized = serializeSessionConversation(
      await readFile(path, "utf8"),
    );

    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "Summarize the release notes." }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Read the source first." },
          {
            type: "toolCall",
            id: "call-1",
            name: "fetch_page",
            arguments: { url: "https://example.invalid/release" },
          },
        ],
        api: "openai-responses",
        provider: "test",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "fetch_page",
        content: [{ type: "text", text: "Version 2 reduces memory use." }],
        details: {},
        isError: false,
        timestamp: 3,
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Version 2 mainly reduces memory use." },
        ],
        api: "openai-responses",
        provider: "test",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 4,
      },
    ] satisfies AgentMessage[];
    const upstream = serializeConversation(convertToLlm(messages));

    expect(serialized).toEqual({
      messageCount: 4,
      conversation: SANITIZED_CONVERSATION,
    });
    expect(serialized.conversation).toBe(upstream);
  });

  test("只序列化当前 parentId branch", () => {
    const source = [
      { type: "session", id: "branch-session" },
      {
        type: "message",
        id: "user",
        parentId: null,
        message: { role: "user", content: "Choose a branch." },
      },
      {
        type: "message",
        id: "abandoned",
        parentId: "user",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Abandoned secret." }],
        },
      },
      {
        type: "message",
        id: "active",
        parentId: "user",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Active answer." }],
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")
      .concat("\n");

    expect(serializeSessionConversation(source)).toEqual({
      messageCount: 2,
      conversation: "[User]: Choose a branch.\n\n[Assistant]: Active answer.",
    });
  });

  test("超过 80,000 字符时只保留会话尾部并写入原提示", () => {
    const source = Array.from(
      { length: 500 },
      () => SANITIZED_CONVERSATION,
    ).join("\n\n");
    const truncated = truncateConversationForSummary(source);

    expect(truncated).toEqual(baselineTruncateConversationForSummary(source));
    expect(truncated.text.endsWith(SANITIZED_CONVERSATION)).toBeTrue();
    expect(
      buildExitSummaryPrompt(
        truncated.text,
        truncated.truncated,
        truncated.totalChars,
      ),
    ).toBe(
      baselineBuildExitSummaryPrompt(
        truncated.text,
        truncated.truncated,
        truncated.totalChars,
      ),
    );
  });

  test("使用原时间注释、短 session ID 和 session-end 标题", () => {
    const sessionId = "01a06c16-3975-7e76-ada1-5dc1dacfe965";
    const timestamp = "2026-09-04 11:03:25";
    expect(formatExitSummaryEntry(SUMMARY, sessionId, timestamp)).toBe(
      baselineFormatExitSummaryEntry(SUMMARY, sessionId, timestamp),
    );
  });

  test("Markdown 和全空过滤与 commit 基线逐项一致", () => {
    const cases = [
      SUMMARY,
      [
        "### Decisions",
        "None.",
        "### Lessons Learned",
        "- None.",
        "### Notes",
        "None",
        "### Follow-ups",
        "* none.",
      ].join("\n"),
      [
        "### Decisions",
        "- Ship:",
        "  - API is ready.",
        "### Lessons Learned",
        "- Long bullets can continue",
        "  on another line.",
        "### Notes",
        "- Keep this example:",
        "  ```ts",
        "  const value = 1;",
        "  ```",
        "### Follow-ups",
        "None.",
      ].join("\n"),
      [
        "### Decisions",
        "### Lessons Learned",
        "### Notes",
        "### Follow-ups",
      ].join("\n"),
      SUMMARY.replace("### Notes", "### Observations"),
      `### Notes\n- ${"x".repeat(70 * 1024)}`,
    ];

    for (const summary of cases) {
      expect(parseExitSummary(summary)).toBe(
        baselineIsExitSummaryEmpty(summary) ? null : summary.trim(),
      );
    }
  });
});
