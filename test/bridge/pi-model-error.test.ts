import { describe, expect, test } from "bun:test";
import { summarizePiModelError } from "../../src/bridge/pi-model-error";

describe("summarizePiModelError", () => {
  test("解析 OpenAI 400 的类型、编码和参数位置", () => {
    const summary = summarizePiModelError(
      'OpenAI API error (400): {"type":"invalid_request_error","code":"invalid_value","message":"synthetic image detail","param":"input[99].content[1].image_url"}',
    );
    expect(summary).toEqual({
      error_kind: "invalid_request_error",
      http_status: 400,
      provider_code: "invalid_value",
      error_param: "input[99].content[1].image_url",
    });
  });

  test("空错误只记空模型错误", () => {
    expect(summarizePiModelError(undefined)).toEqual({
      error_kind: "empty_model_error",
    });
    expect(summarizePiModelError("  ")).toEqual({
      error_kind: "empty_model_error",
    });
  });

  test("不安全或超长字段会被丢弃，不回显原文", () => {
    const secret = "TEST_ONLY_SECRET_TOKEN";
    const summary = summarizePiModelError(
      `Upstream error (502): {"type":"bad;type ${secret}","code":"code with spaces","message":"${secret}","param":"${secret}/../etc"}`,
    );
    expect(summary).toEqual({
      error_kind: "model_error",
      http_status: 502,
    });
    expect(JSON.stringify(summary)).not.toContain(secret);
  });
});
