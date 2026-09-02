import { describe, expect, test } from "bun:test";
import { splitTelegramMarkdown } from "../../src/telegram/markdown";

describe("splitTelegramMarkdown", () => {
  test("转换 MarkdownV2 并让每段不超过 UTF-16 限制", () => {
    const chunks = splitTelegramMarkdown(
      Array.from(
        { length: 400 },
        (_, index) => `**条目 ${index}**: a+b-c.`,
      ).join("\n\n"),
      300,
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.markdownV2.length <= 300)).toBeTrue();
    expect(chunks[0]?.markdownV2).toContain("*条目 0*");
  });

  test("超长代码围栏分段后每段都重新闭合围栏", () => {
    const source = `\`\`\`ts\n${"const value = 1;\n".repeat(200)}\`\`\``;
    const chunks = splitTelegramMarkdown(source, 250);

    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.every((chunk) => chunk.source.startsWith("```ts\n")),
    ).toBeTrue();
    expect(chunks.every((chunk) => chunk.source.endsWith("\n```"))).toBeTrue();
    expect(chunks.every((chunk) => chunk.markdownV2.length <= 250)).toBeTrue();
  });

  test("不会切断 UTF-16 surrogate pair", () => {
    const chunks = splitTelegramMarkdown("𠮷".repeat(100), 40);
    expect(chunks.map((chunk) => chunk.source).join("")).toBe("𠮷".repeat(100));
  });
});
