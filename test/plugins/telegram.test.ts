import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  parseTelegramOutboundResult,
  TELEGRAM_OUTBOUND_PROTOCOL_TITLE,
} from "../../plugins/telegram/protocol";
import { telegramOutboundTools } from "../../plugins/telegram";

interface UiCall {
  title: string;
  placeholder?: string;
  timeout?: number;
  signal?: AbortSignal;
}

function rpcContext(
  response: string | undefined,
  calls: UiCall[],
): ExtensionContext {
  return {
    mode: "rpc",
    ui: {
      input: async (
        title: string,
        placeholder?: string,
        options?: { timeout?: number; signal?: AbortSignal },
      ) => {
        calls.push({
          title,
          ...(placeholder !== undefined ? { placeholder } : {}),
          ...(options?.timeout !== undefined
            ? { timeout: options.timeout }
            : {}),
          ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        });
        return response;
      },
    },
  } as unknown as ExtensionContext;
}

describe("Telegram Pi extension", () => {
  test("只注册 document 和 photo 两个顺序工具", () => {
    expect(telegramOutboundTools.map((tool) => tool.name)).toEqual([
      "telegram_send_document",
      "telegram_send_photo",
    ]);
    expect(
      telegramOutboundTools.every(
        (tool) => tool.executionMode === "sequential",
      ),
    ).toBeTrue();
    for (const tool of telegramOutboundTools) {
      expect(tool.parameters).toMatchObject({ additionalProperties: false });
    }
  });

  test("工具通过私有 RPC UI 请求等待发送结果", async () => {
    const calls: UiCall[] = [];
    const context = rpcContext(
      JSON.stringify({
        version: 1,
        status: "sent",
        kind: "document",
        messageId: 42,
        indexed: true,
        fileName: "report.pdf",
        size: 12,
        mimeType: "application/pdf",
      }),
      calls,
    );
    const tool = telegramOutboundTools[0];

    const signal = new AbortController().signal;
    const result = await tool.execute(
      "tool-42",
      { path: "sanitized.pdf", caption: "Report" },
      signal,
      undefined,
      context,
    );

    expect(calls).toEqual([
      {
        title: TELEGRAM_OUTBOUND_PROTOCOL_TITLE,
        placeholder: JSON.stringify({
          version: 1,
          type: "send",
          toolCallId: "tool-42",
          toolName: "telegram_send_document",
          args: { path: "sanitized.pdf", caption: "Report" },
        }),
        timeout: 130_000,
        signal,
      },
    ]);
    expect(result.content).toEqual([
      {
        type: "text",
        text: "Telegram document sent successfully as message 42.",
      },
    ]);
  });

  test("已发送但索引失败时明确告知 Agent 不要重发", async () => {
    const context = rpcContext(
      JSON.stringify({
        version: 1,
        status: "unknown",
        code: "state_persist_failed",
        message: "Local indexing failed",
        telegramSent: true,
        messageId: 43,
      }),
      [],
    );

    await expect(
      telegramOutboundTools[0].execute(
        "tool-index-failed",
        { path: "report.pdf" },
        new AbortController().signal,
        undefined,
        context,
      ),
    ).rejects.toThrow("sent the file as message 43");
  });

  test("unknown 结果会阻止 Agent 自动重发", async () => {
    const context = rpcContext(
      JSON.stringify({
        version: 1,
        status: "unknown",
        code: "telegram_transport_unknown",
        message: "The request outcome cannot be confirmed",
      }),
      [],
    );

    await expect(
      telegramOutboundTools[1].execute(
        "tool-unknown",
        { path: "photo.jpg" },
        new AbortController().signal,
        undefined,
        context,
      ),
    ).rejects.toThrow("Do not retry automatically");
  });
});

describe("parseTelegramOutboundResult", () => {
  test("空 caption 与公开 schema 保持一致", async () => {
    const calls: UiCall[] = [];
    await telegramOutboundTools[0].execute(
      "tool-empty-caption",
      { path: "report.pdf", caption: "" },
      new AbortController().signal,
      undefined,
      rpcContext(
        JSON.stringify({
          version: 1,
          status: "sent",
          kind: "document",
          messageId: 44,
          indexed: true,
          fileName: "report.pdf",
          size: 12,
          mimeType: "application/pdf",
        }),
        calls,
      ),
    );
    expect(JSON.parse(calls[0]?.placeholder ?? "{}").args).toEqual({
      path: "report.pdf",
    });
  });

  test("拒绝无效、额外或类型不匹配的结果", () => {
    expect(() => parseTelegramOutboundResult("not-json")).toThrow(
      "invalid Telegram tool JSON",
    );
    expect(() =>
      parseTelegramOutboundResult(
        JSON.stringify({ version: 2, status: "sent" }),
      ),
    ).toThrow("unsupported Telegram tool version");
    expect(() =>
      parseTelegramOutboundResult(
        JSON.stringify({
          version: 1,
          status: "rejected",
          code: "invalid",
          message: "No",
          extra: true,
        }),
      ),
    ).toThrow("unknown fields");
  });
});
