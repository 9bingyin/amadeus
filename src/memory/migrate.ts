import { createHash } from "node:crypto";

const TIMESTAMP_PATTERN =
  /^<!-- (?:(?:last updated: )?\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}|HANDOFF \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[[^\]\r\n]+\] -->$/;
const OLD_EXTRACTION_MARKER_PATTERN =
  /^<!-- amadeus-memory:extract:(\d+):([^:\r\n]+):(\d+):(\d+):(\d+):(\d+):(\d+) -->$/;
const SOURCE_SESSION_PATTERN = /^<!-- source-session: [^\r\n]+ -->$/;

interface LegacyExtractionFragment {
  start: number;
  end: number;
  sessionId: string;
  timestamp: string;
  marker: string;
  content: string;
}

export interface MemoryDailyMigrationResult {
  content: string;
  migratedFragments: number;
  migratedSessions: number;
  ambiguousFragments: number;
}

export function migrateLegacyExtractionFragments(
  content: string,
): MemoryDailyMigrationResult {
  const scan = findLegacyExtractionFragments(content);
  if (scan.ambiguousFragments > 0 || scan.fragments.length === 0) {
    return {
      content,
      migratedFragments: 0,
      migratedSessions: 0,
      ambiguousFragments: scan.ambiguousFragments,
    };
  }
  const fragments = scan.fragments;

  const bySession = new Map<string, LegacyExtractionFragment[]>();
  for (const fragment of fragments) {
    const sessionFragments = bySession.get(fragment.sessionId) ?? [];
    sessionFragments.push(fragment);
    bySession.set(fragment.sessionId, sessionFragments);
  }

  const firstBySession = new Map(
    [...bySession].map(([sessionId, sessionFragments]) => [
      sessionId,
      sessionFragments[0],
    ]),
  );
  let migrated = content;
  for (const fragment of [...fragments].reverse()) {
    const isFirst = firstBySession.get(fragment.sessionId) === fragment;
    const replacement = isFirst
      ? `${formatMigratedSummary(bySession.get(fragment.sessionId) ?? [])}${
          fragment.end < content.length ? "\n\n" : "\n"
        }`
      : "";
    migrated =
      migrated.slice(0, fragment.start) +
      replacement +
      migrated.slice(fragment.end);
  }

  return {
    content: migrated,
    migratedFragments: fragments.length,
    migratedSessions: bySession.size,
    ambiguousFragments: 0,
  };
}

function findLegacyExtractionFragments(content: string): {
  fragments: LegacyExtractionFragment[];
  ambiguousFragments: number;
} {
  const lines = content.split("\n");
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }

  const fragments: LegacyExtractionFragment[] = [];
  let ambiguousFragments = 0;
  for (let index = 0; index + 1 < lines.length; index += 1) {
    const timestamp = lines[index] ?? "";
    const marker = lines[index + 1] ?? "";
    const markerMatch = marker.match(OLD_EXTRACTION_MARKER_PATTERN);
    if (!TIMESTAMP_PATTERN.test(timestamp) || !markerMatch) {
      continue;
    }

    let endLine = index + 2;
    while (
      endLine < lines.length &&
      (lines[endLine] ?? "").trim() &&
      !isGeneratedEntryStart(lines, endLine)
    ) {
      endLine += 1;
    }
    const bodyLines = lines.slice(index + 2, endLine);
    const body = bodyLines.join("\n").trim();
    if (!body) {
      ambiguousFragments += 1;
      continue;
    }
    if (bodyLines.length !== 1) {
      ambiguousFragments += 1;
      index = endLine - 1;
      continue;
    }
    fragments.push({
      start: offsets[index] ?? 0,
      end:
        (lines[endLine] ?? "").trim() === ""
          ? (offsets[endLine + 1] ?? content.length)
          : (offsets[endLine] ?? content.length),
      sessionId: markerMatch[2] ?? "",
      timestamp,
      marker,
      content: body,
    });
    index = endLine - 1;
  }
  return { fragments, ambiguousFragments };
}

function isGeneratedEntryStart(
  lines: readonly string[],
  index: number,
): boolean {
  const line = lines[index] ?? "";
  return SOURCE_SESSION_PATTERN.test(line) || TIMESTAMP_PATTERN.test(line);
}

function formatMigratedSummary(
  fragments: readonly LegacyExtractionFragment[],
): string {
  const first = fragments[0];
  if (!first) {
    throw new Error("Cannot format an empty migration summary");
  }
  const notes = fragments
    .map((fragment) => fragment.content.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const markerHash = createHash("sha256")
    .update(fragments.map((fragment) => fragment.marker).join("\n"))
    .digest("hex")
    .slice(0, 16);
  return [
    `<!-- source-session: ${escapeCommentValue(first.sessionId)} -->`,
    first.timestamp,
    "## Session Summary (migrated)",
    `### Notes\n${notes.map((note) => `- ${note}`).join("\n")}`,
    `<!-- amadeus-memory:migrate:${markerHash} -->`,
  ].join("\n\n");
}

function escapeCommentValue(value: string): string {
  return value.replace(/[<>\r\n]/g, "").replaceAll("--", "—");
}
