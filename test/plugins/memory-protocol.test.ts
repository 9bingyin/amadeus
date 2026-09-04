import { describe, expect, test } from "bun:test";
import {
  encodeMemoryUiRequest,
  isMemoryToolName,
  MEMORY_CONTENT_MAX_CHARS,
  MEMORY_PROTOCOL_TITLE,
  MEMORY_SNAPSHOT_MAX_CHARS,
  MEMORY_TOOL_NAMES,
  parseMemorySnapshotResult,
  parseMemoryToolArguments,
  parseMemoryToolResult,
  parseMemoryUiRequest,
} from "../../plugins/memory/protocol";

describe("Memory protocol", () => {
  test("固定协议标题和七个兼容工具名", () => {
    expect(MEMORY_PROTOCOL_TITLE).toBe("amadeus.memory.v1");
    expect(MEMORY_TOOL_NAMES).toEqual([
      "memory_write",
      "memory_forget",
      "memory_restore",
      "memory_read",
      "memory_search",
      "memory_status",
      "scratchpad",
    ]);
    expect(MEMORY_TOOL_NAMES.every(isMemoryToolName)).toBeTrue();
    expect(isMemoryToolName("telegram_send_photo")).toBeFalse();
  });

  test("严格编解码 snapshot 和 tool UI 请求", () => {
    expect(
      parseMemoryUiRequest(
        encodeMemoryUiRequest({ version: 1, type: "snapshot_get" }),
      ),
    ).toEqual({ version: 1, type: "snapshot_get" });
    expect(
      parseMemoryUiRequest(
        encodeMemoryUiRequest({
          version: 1,
          type: "tool_execute",
          toolCallId: "call-1",
          toolName: "memory_write",
          args: { target: "long_term", content: "Uses Bun" },
        }),
      ),
    ).toEqual({
      version: 1,
      type: "tool_execute",
      toolCallId: "call-1",
      toolName: "memory_write",
      args: { target: "long_term", content: "Uses Bun" },
    });
    expect(() =>
      parseMemoryUiRequest(
        JSON.stringify({ version: 1, type: "snapshot_get", extra: true }),
      ),
    ).toThrow("unknown fields");
    expect(() =>
      parseMemoryUiRequest(
        JSON.stringify({ version: 2, type: "snapshot_get" }),
      ),
    ).toThrow("unsupported version");
  });

  test("解析七个工具的兼容参数", () => {
    expect(
      parseMemoryToolArguments("memory_write", {
        target: "long_term",
        content: "#preference Uses Bun",
        mode: "append",
      }),
    ).toEqual({
      toolName: "memory_write",
      target: "long_term",
      content: "#preference Uses Bun",
      mode: "append",
    });
    expect(
      parseMemoryToolArguments("memory_forget", {
        match: "old preference",
        target: "daily",
        date: "2026-09-04",
      }),
    ).toEqual({
      toolName: "memory_forget",
      match: "old preference",
      target: "daily",
      date: "2026-09-04",
    });
    expect(
      parseMemoryToolArguments("memory_restore", { recoveryId: "record-1" }),
    ).toEqual({ toolName: "memory_restore", recoveryId: "record-1" });
    expect(
      parseMemoryToolArguments("memory_read", {
        target: "daily",
        date: "2026-09-04",
      }),
    ).toEqual({
      toolName: "memory_read",
      target: "daily",
      date: "2026-09-04",
    });
    expect(
      parseMemoryToolArguments("memory_search", {
        query: "package manager",
        mode: "semantic",
        limit: 10,
      }),
    ).toEqual({
      toolName: "memory_search",
      query: "package manager",
      mode: "semantic",
      limit: 10,
    });
    expect(parseMemoryToolArguments("memory_status", {})).toEqual({
      toolName: "memory_status",
    });
    expect(
      parseMemoryToolArguments("scratchpad", {
        action: "add",
        text: "follow up",
      }),
    ).toEqual({ toolName: "scratchpad", action: "add", text: "follow up" });
  });

  test("兼容模型为 memory_read 补出的空 date", () => {
    expect(
      parseMemoryToolArguments("memory_read", {
        target: "long_term",
        date: "",
      }),
    ).toEqual({ toolName: "memory_read", target: "long_term" });
    expect(
      parseMemoryToolArguments("memory_read", { target: "list", date: "" }),
    ).toEqual({ toolName: "memory_read", target: "list" });
    expect(
      parseMemoryToolArguments("memory_read", {
        target: "scratchpad",
        date: "",
      }),
    ).toEqual({ toolName: "memory_read", target: "scratchpad" });
    expect(
      parseMemoryToolArguments("memory_read", { target: "daily", date: "" }),
    ).toEqual({ toolName: "memory_read", target: "daily", date: "" });
  });

  test("拒绝未知参数、无效日期、越界 limit 和过大内容", () => {
    expect(() =>
      parseMemoryToolArguments("memory_write", {
        target: "daily",
        content: "text",
        path: "/tmp/memory.md",
      }),
    ).toThrow("unknown fields");
    expect(() =>
      parseMemoryToolArguments("memory_read", {
        target: "daily",
        date: "04-09-2026",
      }),
    ).toThrow("YYYY-MM-DD");
    expect(() =>
      parseMemoryToolArguments("memory_search", {
        query: "query",
        limit: 21,
      }),
    ).toThrow("between 1 and 20");
    expect(() =>
      parseMemoryToolArguments("memory_write", {
        target: "long_term",
        content: "x".repeat(MEMORY_CONTENT_MAX_CHARS + 1),
      }),
    ).toThrow("at most");
  });

  test("严格解析 snapshot 结果", () => {
    expect(
      parseMemorySnapshotResult(
        JSON.stringify({
          version: 1,
          status: "ready",
          revision: 3,
          content: "memory",
        }),
      ),
    ).toEqual({
      version: 1,
      status: "ready",
      revision: 3,
      content: "memory",
    });
    expect(
      parseMemorySnapshotResult(
        JSON.stringify({
          version: 1,
          status: "unavailable",
          code: "not_ready",
        }),
      ),
    ).toEqual({ version: 1, status: "unavailable", code: "not_ready" });
    expect(() =>
      parseMemorySnapshotResult(
        JSON.stringify({
          version: 1,
          status: "ready",
          revision: 0,
          content: "x".repeat(MEMORY_SNAPSHOT_MAX_CHARS + 1),
        }),
      ),
    ).toThrow("at most");
    expect(() =>
      parseMemorySnapshotResult(
        JSON.stringify({
          version: 1,
          status: "unavailable",
          code: "not_ready",
          content: "unexpected",
        }),
      ),
    ).toThrow("unknown fields");
  });

  test("严格解析 completed、rejected 和 unknown 工具结果", () => {
    const providerReceiptId =
      "memory:session:call_memoryStatus|fc_memoryStatus";
    expect(
      parseMemoryToolResult(
        JSON.stringify({
          version: 1,
          status: "completed",
          receiptId: providerReceiptId,
          content: "Stored.",
        }),
      ),
    ).toEqual({
      version: 1,
      status: "completed",
      receiptId: providerReceiptId,
      content: "Stored.",
    });
    expect(
      parseMemoryToolResult(
        JSON.stringify({
          version: 1,
          status: "rejected",
          code: "invalid_arguments",
          message: "Invalid arguments",
        }),
      ),
    ).toEqual({
      version: 1,
      status: "rejected",
      code: "invalid_arguments",
      message: "Invalid arguments",
    });
    expect(
      parseMemoryToolResult(
        JSON.stringify({
          version: 1,
          status: "unknown",
          code: "response_lost",
          message: "Result cannot be confirmed",
          committed: true,
          receiptId: providerReceiptId,
        }),
      ),
    ).toMatchObject({
      status: "unknown",
      committed: true,
      receiptId: providerReceiptId,
    });
    expect(() =>
      parseMemoryToolResult(
        JSON.stringify({
          version: 1,
          status: "unknown",
          code: "response_lost",
          message: "Result cannot be confirmed",
          committed: true,
        }),
      ),
    ).toThrow("provided together");
    const opaqueReceipt = parseMemoryToolResult(
      JSON.stringify({
        version: 1,
        status: "completed",
        receiptId: "memory:session:call-1\nopaque",
        content: "Stored.",
      }),
    );
    expect(opaqueReceipt.status).toBe("completed");
    if (opaqueReceipt.status !== "completed") {
      throw new Error("预期 completed receipt");
    }
    expect(opaqueReceipt.receiptId).toBe("memory:session:call-1\nopaque");
    expect(() =>
      parseMemoryToolResult(
        JSON.stringify({
          version: 1,
          status: "completed",
          receiptId: "receipt-1",
          content: "Stored.",
          code: "unexpected",
        }),
      ),
    ).toThrow("unknown fields");
  });
});
