import { expect, test } from "bun:test";
import { toolProgressLine } from "./progress";

test("Shows tool icons and key arguments without expanding codemode", () => {
  const cases = [
    ["read", { path: "src/main.ts" }, "\u{1f4d6} Read: src/main.ts"],
    [
      "memory_create",
      { name: "preferences", content: "Hidden memory body" },
      "\u{1f6e0}\ufe0f Memory Create: preferences",
    ],
    [
      "session_search",
      { query: "数据库迁移" },
      "\u{1f50d} Session Search: 数据库迁移",
    ],
    [
      "session_read",
      { fromEntryId: 7 },
      "\u{1f4d6} Session Read: fromEntryId=7",
    ],
    [
      "session_read",
      { fromEntryId: 7, limit: 2 },
      "\u{1f4d6} Session Read: fromEntryId=7, limit=2",
    ],
    ["session_read", { limit: 5 }, "\u{1f4d6} Session Read: start, limit=5"],
    ["session_read", {}, "\u{1f4d6} Session Read: start"],
    [
      "write",
      { path: "report.txt", content: "Hidden file body" },
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
    ["schedule", { action: "list" }, "\u23f1\ufe0f Schedule: list"],
    [
      "schedule",
      { action: "create", name: "check", command: "hidden script" },
      "\u23f1\ufe0f Schedule: create check",
    ],
    [
      "schedule",
      { action: "list", id: 42 },
      "\u23f1\ufe0f Schedule: list id=42",
    ],
    [
      "schedule",
      { action: "delete", id: 42 },
      "\u23f1\ufe0f Schedule: delete id=42",
    ],
    ["custom", {}, "\u{1f6e0}\ufe0f Custom"],
  ] as const;
  for (const [name, args, expected] of cases)
    expect(toolProgressLine(name, args)).toBe(expected);
});

test("Displays history pagination without exposing raw cursors", () => {
  const cursor = JSON.stringify({ entryId: 7, messageIndex: 0, through: 42 });
  expect(toolProgressLine("session_read", { cursor })).toBe(
    "\u{1f4d6} Session Read: next page",
  );
  const line = toolProgressLine("session_read", { cursor, limit: 10 });
  expect(line).toBe("\u{1f4d6} Session Read: next page, limit=10");
  expect(line).not.toContain(cursor);
  expect(line).not.toContain("through");
});

test("Limits progress by Unicode code points without splitting surrogate pairs", () => {
  const code = "检查".repeat(80) + String.fromCodePoint(0x1f4e6);
  const line = toolProgressLine("codemode", { code });
  const full = `\u{1f4e6} Codemode: ${code}`;
  expect(line).toBe(Array.from(full).slice(0, 59).join("") + "…");
  expect(Array.from(line)).toHaveLength(60);
  expect(toolProgressLine("read", { path: "a".repeat(10) })).not.toContain("…");
});

test("Redacts the Bot token before truncating progress", () => {
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
