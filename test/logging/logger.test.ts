import { describe, expect, test } from "bun:test";
import {
  createInfoLogger,
  errorName,
  formatInfoLog,
} from "../../src/logging/logger";

describe("InfoLogger", () => {
  test("输出固定前缀和按名称排序的字段", () => {
    const line = formatInfoLog(
      "telegram_message_accepted",
      {
        update_id: 3,
        chat_id: 1,
        message_id: 2,
        attachment_count: 1,
        photo_count: 1,
        document_count: 0,
        has_forward: false,
        has_reply: true,
        has_quote: false,
        message_type: "photo",
      },
      new Date("2026-09-01T00:00:00.123Z"),
    );

    expect(line).toBe(
      'time=2026-09-01T00:00:00.123Z level=info event=telegram_message_accepted attachment_count=1 chat_id=1 document_count=0 has_forward=false has_quote=false has_reply=true message_id=2 message_type="photo" photo_count=1 update_id=3',
    );
  });

  test("把不透明 ID 和未知工具名称转换为安全指纹", () => {
    const line = formatInfoLog(
      "pi_tool_started",
      {
        chat_id: 1,
        tool_call_id: "aW1hZ2Utc2VjcmV0",
        tool_name: "https://example.invalid/private\npath\u0001",
        status: "running",
      },
      new Date("2026-09-01T00:00:00Z"),
    );

    expect(line).toContain('tool_call_id="sha256:');
    expect(line).toContain('tool_name="sha256:');
    expect(line).not.toContain("aW1hZ2Utc2VjcmV0");
    expect(line).not.toContain("example.invalid");
    expect(line.split("\n")).toHaveLength(1);

    const knownTool = formatInfoLog(
      "pi_tool_started",
      {
        chat_id: 1,
        tool_call_id: "call-1",
        tool_name: "read",
        status: "running",
      },
      new Date("2026-09-01T00:00:00Z"),
    );
    expect(knownTool).toContain('tool_name="read"');
    expect(knownTool).not.toContain("call-1");
  });

  test("编码普通字符串中的空格、换行、引号、控制字符和空值", () => {
    const special = formatInfoLog(
      "service_stop_requested",
      {
        signal:
          'SIG INT\n"quoted"\u0001\u007f\u0085\u009f\u2028\u2029\\' as "SIGINT",
      },
      new Date("2026-09-01T00:00:00Z"),
    );
    const empty = formatInfoLog(
      "service_stop_requested",
      { signal: "" as "SIGINT" },
      new Date("2026-09-01T00:00:00Z"),
    );

    expect(special).toContain('signal="SIG INT\\n\\"quoted\\"\\u0001');
    expect(special).toContain("\\u007f\\u0085\\u009f\\u2028\\u2029");
    expect(special).not.toMatch(/[\u007f-\u009f\u2028\u2029]/);
    expect(special.split("\n")).toHaveLength(1);
    expect(empty).toContain('signal=""');
  });

  test("忽略额外字段并拒绝非有限数字", () => {
    const fields = { process_id: 1, text: "private message" };
    const filtered = formatInfoLog(
      "service_started",
      fields,
      new Date("2026-09-01T00:00:00Z"),
    );
    expect(filtered).not.toContain("private message");
    expect(filtered).not.toContain("text=");

    expect(
      formatInfoLog(
        "telegram_file_download_started",
        {
          attachment_kind: "photo",
          chat_id: 1,
          file_unique_id: "unique",
          message_id: 2,
        },
        new Date("2026-09-01T00:00:00Z"),
      ),
    ).not.toContain("file_size_bytes");

    expect(() =>
      formatInfoLog(
        "service_stopped",
        { duration_ms: Number.NaN },
        new Date("2026-09-01T00:00:00Z"),
      ),
    ).toThrow("finite numbers");
  });

  test("sink 失败不会影响调用方", () => {
    const logger = createInfoLogger({
      writeLine: () => {
        throw new Error("sink failed");
      },
    });

    expect(() =>
      logger.info("service_started", { process_id: 1 }),
    ).not.toThrow();
  });
});

describe("errorName", () => {
  test("只返回安全错误名称，不读取 message、cause 或自定义 toString", () => {
    const secret = "TEST_ONLY_SECRET_VALUE";
    const error = new TypeError(`request ${secret} failed`, {
      cause: new Error(`https://api.telegram.org/bot${secret}`),
    });
    let called = false;
    const unknown = {
      toString() {
        called = true;
        return secret;
      },
    };

    expect(errorName(error)).toBe("TypeError");
    expect(errorName(unknown)).toBe("UnknownError");
    expect(called).toBeFalse();
  });

  test("拒绝未知名称和异常 getter", () => {
    const error = new Error("hidden");
    error.name = "aW1hZ2Utc2VjcmV0";
    const throwingName = new Error("hidden");
    Object.defineProperty(throwingName, "name", {
      get() {
        throw new Error("secret getter output");
      },
    });
    const changingName = new Error("hidden");
    let reads = 0;
    Object.defineProperty(changingName, "name", {
      get() {
        reads += 1;
        return reads === 1 ? "Error" : "TEST_ONLY_SECRET_VALUE";
      },
    });

    expect(errorName(error)).toBe("UnknownError");
    expect(errorName(throwingName)).toBe("UnknownError");
    expect(errorName(changingName)).toBe("Error");
    expect(reads).toBe(1);
  });
});
