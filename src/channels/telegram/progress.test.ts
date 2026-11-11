import { expect, test } from "bun:test";
import { toolProgressLine } from "./progress";

test("工具进度沿用旧版图标和关键参数，codemode 展示实际代码", () => {
  const cases = [
    ["read", { path: "src/main.ts" }, "\u{1f4d6} Read: src/main.ts"],
    [
      "write",
      { path: "report.txt", content: "不显示正文" },
      "\u270d\ufe0f Write: report.txt",
    ],
    ["edit", { path: "file.ts" }, "\u{1f4dd} Edit: file.ts"],
    [
      "bash",
      { command: "printf one\n\tprintf two" },
      "\u{1f6e0}\ufe0f Bash: printf one printf two",
    ],
    [
      "codemode",
      { code: "text(\n  await tools.read({ path: 'a' })\n);" },
      "\u{1f4e6} Codemode: text( await tools.read({ path: 'a' }) );",
    ],
    [
      "mcp__exa__exa_web_search",
      { query: "pi durable" },
      "\u{1f6e0}\ufe0f Exa Web Search: pi durable",
    ],
    ["schedule", { action: "list" }, "\u{1f6e0}\ufe0f Schedule: list"],
    ["custom", {}, "\u{1f6e0}\ufe0f Custom"],
  ] as const;
  for (const [name, args, expected] of cases)
    expect(toolProgressLine(name, args)).toBe(expected);
});

test("展示按完整行的 Unicode 码点限制 60，包含图标和省略号且不切断代理对", () => {
  const code = "检查".repeat(80) + String.fromCodePoint(0x1f4e6);
  const line = toolProgressLine("codemode", { code });
  const full = `\u{1f4e6} Codemode: ${code}`;
  expect(line).toBe(Array.from(full).slice(0, 59).join("") + "…");
  expect(Array.from(line)).toHaveLength(60);
  expect(toolProgressLine("read", { path: "a".repeat(10) })).not.toContain("…");
});

test("Bot token 在截断前遮蔽，不泄漏被展示截断的 token 前缀", () => {
  const token = "123456:ABCDEF".repeat(10);
  const line = toolProgressLine(
    "codemode",
    { code: `const token = '${token}'; text('ok');` },
    token,
  );
  expect(line).toContain("[redacted]");
  expect(line).not.toContain("123456");
  expect(Array.from(line).length).toBeLessThanOrEqual(60);
});
