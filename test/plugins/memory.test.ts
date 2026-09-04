import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { injectMemorySnapshot, memoryTools } from "../../plugins/memory";
import {
  MEMORY_PROTOCOL_TITLE,
  parseMemoryUiRequest,
} from "../../plugins/memory/protocol";

interface UiCall {
  title: string;
  placeholder?: string;
  timeout?: number;
}

function toolAt(index: number): (typeof memoryTools)[number] {
  const tool = memoryTools[index];
  if (!tool) {
    throw new Error(`缺少索引为 ${index} 的 memory 工具`);
  }
  return tool;
}

function context(
  mode: ExtensionContext["mode"],
  responses: Array<string | undefined>,
  calls: UiCall[],
): ExtensionContext {
  return {
    mode,
    ui: {
      input: async (
        title: string,
        placeholder?: string,
        options?: { timeout?: number },
      ) => {
        calls.push({
          title,
          ...(placeholder === undefined ? {} : { placeholder }),
          ...(options?.timeout === undefined
            ? {}
            : { timeout: options.timeout }),
        });
        return responses.shift();
      },
    },
  } as unknown as ExtensionContext;
}

describe("Memory Pi extension", () => {
  test("注册七个兼容顺序工具并拒绝额外参数", () => {
    expect(memoryTools.map((tool) => tool.name)).toEqual([
      "memory_write",
      "memory_forget",
      "memory_restore",
      "memory_read",
      "memory_search",
      "memory_status",
      "scratchpad",
    ]);
    expect(
      memoryTools.every((tool) => tool.executionMode === "sequential"),
    ).toBeTrue();
    for (const tool of memoryTools) {
      expect(tool.parameters).toMatchObject({ additionalProperties: false });
    }
  });

  test("工具仅通过严格 Memory UI 协议执行", async () => {
    const calls: UiCall[] = [];
    const result = await toolAt(0).execute(
      "call-1",
      { target: "long_term", content: "Uses Bun" },
      new AbortController().signal,
      undefined,
      context(
        "rpc",
        [
          JSON.stringify({
            version: 1,
            status: "completed",
            receiptId: "session:call-1",
            content: "Stored.",
          }),
        ],
        calls,
      ),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.title).toBe(MEMORY_PROTOCOL_TITLE);
    expect(calls[0]?.timeout).toBe(65_000);
    expect(parseMemoryUiRequest(calls[0]?.placeholder ?? "")).toEqual({
      version: 1,
      type: "tool_execute",
      toolCallId: "call-1",
    });
    expect(result).toEqual({
      content: [{ type: "text", text: "Stored." }],
      details: { status: "completed", receiptId: "session:call-1" },
    });
  });

  test("unknown 和超时结果明确禁止自动重试", async () => {
    await expect(
      toolAt(1).execute(
        "call-unknown",
        { match: "old" },
        new AbortController().signal,
        undefined,
        context(
          "rpc",
          [
            JSON.stringify({
              version: 1,
              status: "unknown",
              code: "response_lost",
              message: "Result cannot be confirmed",
              committed: true,
              receiptId: "session:call-unknown",
            }),
          ],
          [],
        ),
      ),
    ).rejects.toThrow("Do not retry automatically");

    await expect(
      toolAt(2).execute(
        "call-timeout",
        { recoveryId: "record" },
        new AbortController().signal,
        undefined,
        context("rpc", [undefined], []),
      ),
    ).rejects.toThrow("Do not retry automatically");
  });

  test("before_agent_start 只注入宿主稳定快照并使用短超时", async () => {
    const calls: UiCall[] = [];
    const first = await injectMemorySnapshot(
      "base prompt",
      context(
        "rpc",
        [
          JSON.stringify({
            version: 1,
            status: "ready",
            revision: 7,
            content: "### MEMORY.md\nUses Bun",
          }),
        ],
        calls,
      ),
    );
    const second = await injectMemorySnapshot(
      "base prompt",
      context(
        "rpc",
        [
          JSON.stringify({
            version: 1,
            status: "ready",
            revision: 7,
            content: "### MEMORY.md\nUses Bun",
          }),
        ],
        [],
      ),
    );

    expect(first).toEqual(second);
    expect(first?.systemPrompt).toContain("Stable host snapshot, revision 7");
    expect(first?.systemPrompt).toContain("### MEMORY.md\nUses Bun");
    expect(calls[0]?.timeout).toBe(1_000);
    expect(parseMemoryUiRequest(calls[0]?.placeholder ?? "")).toEqual({
      version: 1,
      type: "snapshot_get",
    });
  });

  test("快照超时或无效响应不阻塞 prompt", async () => {
    expect(
      await injectMemorySnapshot("base", context("rpc", [undefined], [])),
    ).toBeUndefined();
    expect(
      await injectMemorySnapshot("base", context("rpc", ["invalid"], [])),
    ).toBeUndefined();
  });

  test("非 RPC 模式不读取快照并拒绝工具调用", async () => {
    const calls: UiCall[] = [];
    const nonRpc = context("tui", [], calls);
    expect(await injectMemorySnapshot("base", nonRpc)).toBeUndefined();
    expect(calls).toEqual([]);
    await expect(
      toolAt(0).execute(
        "call-local",
        { target: "daily", content: "text" },
        new AbortController().signal,
        undefined,
        nonRpc,
      ),
    ).rejects.toThrow("only through Amadeus RPC");
  });
});
