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
  formatExitSummaryEntry,
  parseExitSummary,
  serializeSessionConversation,
  truncateConversationForSummary,
} from "../../src/memory/exit-summary";

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
      conversation: [
        "[User]: Summarize the release notes.",
        "[Assistant thinking]: Read the source first.",
        '[Assistant tool calls]: fetch_page(url="https://example.invalid/release")',
        "[Tool result]: Version 2 reduces memory use.",
        "[Assistant]: Version 2 mainly reduces memory use.",
      ].join("\n\n"),
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
    const source = `discard-${"x".repeat(EXIT_SUMMARY_MAX_CHARS)}-recent`;
    const truncated = truncateConversationForSummary(source);

    expect(truncated).toEqual({
      text: source.slice(-EXIT_SUMMARY_MAX_CHARS),
      truncated: true,
      totalChars: source.length,
    });
    expect(truncated.text).not.toContain("discard-");
    expect(truncated.text.endsWith("-recent")).toBeTrue();
    expect(
      buildExitSummaryPrompt(
        truncated.text,
        truncated.truncated,
        truncated.totalChars,
      ),
    ).toContain(
      `Note: Conversation transcript was truncated to the most recent 80000 of ${source.length} characters.`,
    );
  });

  test("使用原时间注释、短 session ID 和 session-end 标题", () => {
    expect(
      formatExitSummaryEntry(
        SUMMARY,
        "01a06c16-3975-7e76-ada1-5dc1dacfe965",
        "2026-09-04 11:03:25",
      ),
    ).toBe(
      [
        "<!-- 2026-09-04 11:03:25 [01a06c16] -->",
        "## Session Summary (auto, exit: session-end)",
        "",
        SUMMARY,
      ].join("\n"),
    );
  });

  test("严格保留四分区 Markdown，并过滤全空摘要", () => {
    expect(parseExitSummary(SUMMARY)).toBe(SUMMARY);
    expect(
      parseExitSummary(
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
      ),
    ).toBeNull();
    expect(
      parseExitSummary(
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
      ),
    ).not.toBeNull();
    expect(
      parseExitSummary(
        [
          "### Decisions",
          "### Lessons Learned",
          "### Notes",
          "### Follow-ups",
        ].join("\n"),
      ),
    ).toBeNull();
    expect(() =>
      parseExitSummary(SUMMARY.replace("### Notes", "### Observations")),
    ).toThrow("headings");
  });
});
