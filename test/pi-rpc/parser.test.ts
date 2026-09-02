import { describe, expect, test } from "bun:test";
import { parsePiRpcOutput } from "../../src/pi-rpc/parser";

describe("parsePiRpcOutput streaming events", () => {
  test("解析 assistant message_start 和 text_delta", () => {
    expect(
      parsePiRpcOutput(
        '{"type":"message_start","message":{"role":"assistant","content":[]}}',
      ),
    ).toEqual({ type: "message_start", messageRole: "assistant" });

    expect(
      parsePiRpcOutput(
        '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"hello"}}',
      ),
    ).toEqual({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "hello",
      },
    });
  });

  test("保留非文本增量类型但不暴露内容", () => {
    expect(
      parsePiRpcOutput(
        '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"private"}}',
      ),
    ).toEqual({
      type: "message_update",
      assistantMessageEvent: {
        type: "other",
        eventType: "thinking_delta",
      },
    });
  });

  test("拒绝无效 contentIndex", () => {
    expect(() =>
      parsePiRpcOutput(
        '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":-1,"delta":"x"}}',
      ),
    ).toThrow("非负安全整数");
  });

  test("解析 extension UI 的 title 和 placeholder", () => {
    expect(
      parsePiRpcOutput(
        '{"type":"extension_ui_request","id":"ui-1","method":"input","title":"amadeus.telegram.v1","placeholder":"tool-1"}',
      ),
    ).toEqual({
      type: "extension_ui_request",
      id: "ui-1",
      method: "input",
      title: "amadeus.telegram.v1",
      placeholder: "tool-1",
      payload: {
        type: "extension_ui_request",
        id: "ui-1",
        method: "input",
        title: "amadeus.telegram.v1",
        placeholder: "tool-1",
      },
    });
  });
});
