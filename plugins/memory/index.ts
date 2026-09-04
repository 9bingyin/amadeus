import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  encodeMemoryUiRequest,
  MEMORY_PROTOCOL_TITLE,
  MEMORY_SNAPSHOT_RESPONSE_TIMEOUT_MS,
  MEMORY_TOOL_RESPONSE_TIMEOUT_MS,
  parseMemorySnapshotResult,
  parseMemoryToolResult,
} from "./protocol";

const longTermOrDaily = Type.Union([
  Type.Literal("long_term"),
  Type.Literal("daily"),
]);

const tools = [
  {
    name: "memory_write",
    label: "Memory Write",
    description:
      "Write durable facts, decisions, and preferences to MEMORY.md, or append running context to today's daily log.",
    parameters: Type.Object(
      {
        target: longTermOrDaily,
        content: Type.String({ maxLength: 64 * 1024 }),
        mode: Type.Optional(
          Type.Union([Type.Literal("append"), Type.Literal("overwrite")]),
        ),
      },
      { additionalProperties: false },
    ),
  },
  {
    name: "memory_forget",
    label: "Memory Forget",
    description:
      "Remove outdated or incorrect memory entries by case-insensitive substring and create a recovery record.",
    parameters: Type.Object(
      {
        match: Type.String({ minLength: 1, maxLength: 4096 }),
        target: Type.Optional(longTermOrDaily),
        date: Type.Optional(Type.String({ maxLength: 10 })),
      },
      { additionalProperties: false },
    ),
  },
  {
    name: "memory_restore",
    label: "Memory Restore",
    description:
      "Restore entries removed by memory_forget using its recovery ID.",
    parameters: Type.Object(
      { recoveryId: Type.String({ minLength: 1, maxLength: 256 }) },
      { additionalProperties: false },
    ),
  },
  {
    name: "memory_read",
    label: "Memory Read",
    description:
      "Read MEMORY.md, SCRATCHPAD.md, a daily log, or the list of daily logs.",
    parameters: Type.Object(
      {
        target: Type.Union([
          Type.Literal("long_term"),
          Type.Literal("scratchpad"),
          Type.Literal("daily"),
          Type.Literal("list"),
        ]),
        date: Type.Optional(Type.String({ maxLength: 10 })),
      },
      { additionalProperties: false },
    ),
  },
  {
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search memory files. Keyword search is always available; semantic and deep modes use the host qmd index when ready.",
    parameters: Type.Object(
      {
        query: Type.String({ minLength: 1, maxLength: 4096 }),
        mode: Type.Optional(
          Type.Union([
            Type.Literal("keyword"),
            Type.Literal("semantic"),
            Type.Literal("deep"),
          ]),
        ),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      },
      { additionalProperties: false },
    ),
  },
  {
    name: "memory_status",
    label: "Memory Status",
    description:
      "Show memory inventory and the host qmd update and embedding watermarks.",
    parameters: Type.Object({}, { additionalProperties: false }),
  },
  {
    name: "scratchpad",
    label: "Scratchpad",
    description:
      "Manage the persistent checklist with add, done, undo, clear_done, and list actions.",
    parameters: Type.Object(
      {
        action: Type.Union([
          Type.Literal("add"),
          Type.Literal("done"),
          Type.Literal("undo"),
          Type.Literal("clear_done"),
          Type.Literal("list"),
        ]),
        text: Type.Optional(Type.String({ maxLength: 4096 })),
      },
      { additionalProperties: false },
    ),
  },
] as const;

export const memoryTools = tools.map((tool) => ({
  ...tool,
  executionMode: "sequential" as const,
  execute: async (
    toolCallId: string,
    _params: unknown,
    _signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: ExtensionContext,
  ) => executeMemoryTool(toolCallId, ctx),
})) satisfies Array<Parameters<ExtensionAPI["registerTool"]>[0]>;

export default function memoryExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, ctx) =>
    injectMemorySnapshot(event.systemPrompt, ctx),
  );

  for (const tool of memoryTools) {
    pi.registerTool(tool);
  }
}

export async function injectMemorySnapshot(
  systemPrompt: string,
  ctx: ExtensionContext,
): Promise<{ systemPrompt: string } | undefined> {
  if (ctx.mode !== "rpc") {
    return;
  }
  const response = await ctx.ui.input(
    MEMORY_PROTOCOL_TITLE,
    encodeMemoryUiRequest({ version: 1, type: "snapshot_get" }),
    { timeout: MEMORY_SNAPSHOT_RESPONSE_TIMEOUT_MS },
  );
  if (response === undefined) {
    return;
  }

  let snapshot;
  try {
    snapshot = parseMemorySnapshotResult(response);
  } catch {
    return;
  }
  if (snapshot.status !== "ready" || !snapshot.content) {
    return;
  }

  return {
    systemPrompt: [
      systemPrompt,
      "",
      "## Memory",
      `(Stable host snapshot, revision ${snapshot.revision}. Use memory_read or memory_search for the authoritative latest state.)`,
      "Use memory_write to persist important decisions, preferences, durable facts, and explicit requests to remember something.",
      "Use scratchpad for follow-up tasks and temporary reminders.",
      "",
      snapshot.content,
    ].join("\n"),
  };
}

async function executeMemoryTool(toolCallId: string, ctx: ExtensionContext) {
  if (ctx.mode !== "rpc") {
    throw new Error("Amadeus memory is available only through Amadeus RPC");
  }
  const response = await ctx.ui.input(
    MEMORY_PROTOCOL_TITLE,
    encodeMemoryUiRequest({
      version: 1,
      type: "tool_execute",
      toolCallId,
    }),
    { timeout: MEMORY_TOOL_RESPONSE_TIMEOUT_MS },
  );
  if (response === undefined) {
    throw new Error(
      "Amadeus did not return a memory result. Do not retry automatically.",
    );
  }

  const result = parseMemoryToolResult(response);
  if (result.status === "rejected") {
    throw new Error(`Memory operation rejected: ${result.message}`);
  }
  if (result.status === "unknown") {
    const committed = result.committed
      ? ` The mutation may already be committed as receipt ${result.receiptId}.`
      : "";
    throw new Error(
      `Memory operation outcome is unknown: ${result.message}.${committed} Do not retry automatically.`,
    );
  }

  return {
    content: [{ type: "text" as const, text: result.content }],
    ...(result.isError ? { isError: true } : {}),
    details: {
      status: result.status,
      receiptId: result.receiptId,
    },
  };
}
