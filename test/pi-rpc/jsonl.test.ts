import { describe, expect, test } from "bun:test";
import { StrictJsonlDecoder } from "../../src/pi-rpc/jsonl";

describe("StrictJsonlDecoder", () => {
  test("只按 LF 分隔跨 chunk JSONL", () => {
    const decoder = new StrictJsonlDecoder();
    expect(decoder.push(new TextEncoder().encode('{"a":'))).toEqual([]);
    expect(decoder.push(new TextEncoder().encode('1}\n{"b":2}\n'))).toEqual([
      '{"a":1}',
      '{"b":2}',
    ]);
    expect(decoder.finish()).toEqual([]);
  });

  test("拒绝 CRLF 和缺少终止 LF", () => {
    const crlf = new StrictJsonlDecoder();
    expect(() => crlf.push(new TextEncoder().encode("{}\r\n"))).toThrow(
      "只能使用 LF",
    );

    const unterminated = new StrictJsonlDecoder();
    unterminated.push(new TextEncoder().encode("{}"));
    expect(() => unterminated.finish()).toThrow("缺少 LF");
  });
});
