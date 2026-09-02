import { describe, expect, test } from "bun:test";
import {
  parseClearedQueue,
  parseCompactionResult,
  parseLatestAssistantEntryId,
  parseNewSessionResult,
  parseSessionState,
  parseSessionStats,
  requireSuccess,
} from "../../src/pi-rpc/response-data";

describe("Pi RPC response data", () => {
  test("解析 session、队列和 new_session 数据", () => {
    expect(
      parseSessionState({
        model: { provider: "openai-codex", id: "gpt-5.6-sol" },
        thinkingLevel: "high",
        isStreaming: false,
        isCompacting: false,
        steeringMode: "all",
        followUpMode: "one-at-a-time",
        sessionFile: "/sessions/one.jsonl",
        sessionId: "one",
        pendingMessageCount: 2,
      }),
    ).toEqual({
      model: { provider: "openai-codex", id: "gpt-5.6-sol" },
      thinkingLevel: "high",
      isStreaming: false,
      isCompacting: false,
      steeringMode: "all",
      followUpMode: "one-at-a-time",
      sessionFile: "/sessions/one.jsonl",
      sessionId: "one",
      pendingMessageCount: 2,
    });
    expect(parseClearedQueue({ steering: ["one"], followUp: ["two"] })).toEqual(
      { steering: ["one"], followUp: ["two"] },
    );
    expect(parseNewSessionResult({ cancelled: false })).toEqual({
      cancelled: false,
    });
    expect(
      parseSessionStats({
        sessionId: "session-1",
        contextUsage: {
          tokens: 120_000,
          contextWindow: 200_000,
          percent: 60,
        },
      }),
    ).toEqual({
      sessionId: "session-1",
      contextUsage: {
        tokens: 120_000,
        contextWindow: 200_000,
        percent: 60,
      },
    });
    expect(() => parseSessionStats({})).toThrow("get_session_stats.sessionId");
    expect(
      parseCompactionResult({
        summary: "private summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 150_000,
        estimatedTokensAfter: 32_000,
      }),
    ).toEqual({ tokensBefore: 150_000, estimatedTokensAfter: 32_000 });
  });

  test("从 entries 末尾选择最新 assistant entry", () => {
    expect(
      parseLatestAssistantEntryId({
        entries: [
          {
            type: "message",
            id: "assistant-1",
            message: { role: "assistant" },
          },
          { type: "message", id: "user-2", message: { role: "user" } },
          {
            type: "message",
            id: "assistant-2",
            message: { role: "assistant" },
          },
        ],
      }),
    ).toBe("assistant-2");
  });

  test("只接受响应对象自身的字段", () => {
    const inherited: unknown = Object.create({ cancelled: false });

    expect(() => parseNewSessionResult(inherited)).toThrow(
      "Pi RPC new_session.cancelled 必须是布尔值",
    );
  });

  test("拒绝失败响应和缺失 assistant entry", () => {
    expect(() =>
      requireSuccess(
        {
          type: "response",
          command: "get_state",
          success: false,
          error: "failed",
        },
        "get_state",
      ),
    ).toThrow("Pi RPC get_state 失败：failed");
    expect(() => parseLatestAssistantEntryId({ entries: [] })).toThrow(
      "找不到最终 assistant entry",
    );
  });
});
