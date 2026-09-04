import { describe, expect, test } from "bun:test";
import {
  migrateLegacyExtractionFragments,
  migrateManagedAutoSummaries,
} from "../../src/memory/migrate";

const legacySummary = `<!-- source-session: legacy-session -->
<!-- 2026-09-04 02:42:55 [legacy] -->
## Session Summary (backfill)

### Decisions
- 保留旧摘要。
`;

function oldFragment(
  sessionId: string,
  fromOffset: number,
  toOffset: number,
  content: string,
): string {
  return `<!-- 2026-09-04 11:03:25 [amadeus] -->
<!-- amadeus-memory:extract:123:${sessionId}:64770:3027963:${fromOffset}:${toOffset}:0 -->
${content}`;
}

describe("memory daily migration", () => {
  test("只把旧 Amadeus extraction 碎片按 session 合并为结构化摘要", () => {
    const source = [
      legacySummary.trimEnd(),
      oldFragment("session-a", 0, 260576, "调查了 RTX Spark。"),
      "这段手写内容必须原样保留。",
      oldFragment("session-a", 260576, 491606, "确认官方价格尚未公布。"),
      oldFragment("session-b", 0, 100, "完成服务清理。"),
    ].join("\n\n");

    const result = migrateLegacyExtractionFragments(`${source}\n`);

    expect(result.migratedFragments).toBe(3);
    expect(result.migratedSessions).toBe(2);
    expect(result.ambiguousFragments).toBe(0);
    expect(result.content).toStartWith(legacySummary);
    expect(result.content.match(/source-session: session-a/g)).toHaveLength(1);
    expect(result.content.match(/source-session: session-b/g)).toHaveLength(1);
    expect(result.content).toContain("## Session Summary (migrated)");
    expect(result.content).toContain(
      "### Notes\n- 调查了 RTX Spark。\n- 确认官方价格尚未公布。",
    );
    expect(result.content).toContain("这段手写内容必须原样保留。");
    expect(result.content).not.toContain(
      "amadeus-memory:extract:123:session-a",
    );
    expect(result.content).toMatch(/amadeus-memory:migrate:[0-9a-f]{16}/);
  });

  test("不修改新短标记、手写内容或已经迁移的文件", () => {
    const source = `<!-- 2026-09-04 12:00:00 [amadeus] -->
<!-- amadeus-memory:extract:0123456789abcdef -->
手写内容。
`;

    const first = migrateLegacyExtractionFragments(source);
    const second = migrateLegacyExtractionFragments(first.content);

    expect(first).toEqual({
      content: source,
      migratedFragments: 0,
      migratedSessions: 0,
      migratedManagedSummaries: 0,
      ambiguousFragments: 0,
    });
    expect(second).toEqual(first);
  });

  test("只迁移 Amadeus 管理的 auto summary", () => {
    const originalPiMemory = [
      "<!-- 2026-09-04 10:00:00 [pi-sessi] -->",
      "## Session Summary (auto, exit: session-end)",
      "",
      "### Decisions",
      "None.",
      "### Lessons Learned",
      "None.",
      "### Notes",
      "- 原 pi-memory 摘要。",
      "### Follow-ups",
      "None.",
    ].join("\n");
    const managed = [
      "<!-- source-session: amadeus-session -->",
      "<!-- 2026-09-04 11:03:25 [amadeus] -->",
      "## Session Summary (auto)",
      "",
      "### Notes",
      "- 当前 Amadeus 摘要。",
      "",
      "<!-- amadeus-memory:extract:0123456789abcdef -->",
      "<!-- amadeus-summary-end:fedcba9876543210 -->",
    ].join("\n");
    const handwritten = "手写内容必须保持原样。";
    const suffix = "摘要后的手写内容也必须保持原样。";
    const source = `${originalPiMemory}\n\n${handwritten}\n\n${managed}\n\n${suffix}\n`;

    const result = migrateManagedAutoSummaries(source);

    expect(result.migratedManagedSummaries).toBe(1);
    expect(result.ambiguousFragments).toBe(0);
    expect(result.content).toStartWith(`${originalPiMemory}\n\n${handwritten}`);
    expect(result.content).toContain(
      "<!-- 2026-09-04 11:03:25 [amadeus-] -->\n## Session Summary (auto, exit: session-end)",
    );
    expect(result.content).toContain("### Decisions\nNone.");
    expect(result.content).toContain("### Notes\n- 当前 Amadeus 摘要。");
    expect(result.content).not.toContain(
      "<!-- source-session: amadeus-session -->",
    );
    expect(result.content).toEndWith(`\n\n${suffix}\n`);
  });

  test("遇到多段 Markdown 或紧邻手写内容时拒绝整文件迁移", () => {
    const source = oldFragment(
      "session-a",
      0,
      260576,
      "## 调查结果\n正文可能属于提取内容，也可能是手写内容。",
    );

    const result = migrateLegacyExtractionFragments(`${source}\n`);

    expect(result).toEqual({
      content: `${source}\n`,
      migratedFragments: 0,
      migratedSessions: 0,
      migratedManagedSummaries: 0,
      ambiguousFragments: 1,
    });
  });
});
