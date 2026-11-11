import { expect, test } from "bun:test";
import { formatReply } from "./format";

test("普通 Markdown 转 Telegram 实体，保留代码、链接和中文格式", () => {
  const source =
    '# 标题\n\n**重点**与 __重点__、_斜体_、`a_b`。\n\n[文档](https://example.com/a_b?q=1&n=2)\n\n```ts\nconst value = "<>&";\n```';
  const chunks = formatReply(source);
  expect(chunks).toHaveLength(1);
  const message = chunks[0];
  expect(message?.text).toContain("重点与 重点");
  expect(message?.text).toContain('const value = "<>&";');
  expect(message?.text).not.toContain("**");
  expect(message?.entities).toContainEqual({
    type: "text_link",
    offset: expect.any(Number),
    length: 2,
    url: "https://example.com/a_b?q=1&n=2",
  });
  expect(message?.entities).toContainEqual({
    type: "pre",
    offset: expect.any(Number),
    length: expect.any(Number),
    language: "ts",
  });
  expect(message?.entities.some((entity) => entity.type === "italic")).toBe(
    true,
  );
  expect(
    message?.entities.filter((entity) => entity.type === "bold"),
  ).toHaveLength(3);
});

test("长代码块按 Telegram 长度分段，实体边界不越界也不切断代理对", () => {
  const source =
    "```text\n" +
    ("a".repeat(100) + String.fromCodePoint(0x1f4e6) + "\n").repeat(100) +
    "```";
  const chunks = formatReply(source);
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) {
    expect(chunk.text.length).toBeLessThanOrEqual(4096);
    expect(chunk.entities.some((entity) => entity.type === "pre")).toBe(true);
    for (const entity of chunk.entities) {
      expect(entity.offset).toBeGreaterThanOrEqual(0);
      expect(entity.offset + entity.length).toBeLessThanOrEqual(
        chunk.text.length,
      );
    }
    const end = chunk.text.charCodeAt(chunk.text.length - 1);
    expect(end >= 0xd800 && end <= 0xdbff).toBe(false);
  }
});

test("流式未闭合语法由库修复，完整输入与最终渲染一致，空内容不发送", () => {
  const preview = formatReply("**未完成", true);
  expect(preview[0]?.text).toBe("未完成");
  expect(preview[0]?.entities).toEqual([
    { type: "bold", offset: 0, length: 3 },
  ]);
  const source = "**已完成**\n\n```ts\nconst x = 1;\n```";
  expect(formatReply(source, true)).toEqual(formatReply(source));
  expect(formatReply("  \n\t")).toEqual([]);
});
