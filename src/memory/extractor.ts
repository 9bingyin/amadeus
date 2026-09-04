import { open } from "node:fs/promises";
import type { InfoLogger } from "../logging/logger";
import { PiRpcClient, type PiRpcClientLike } from "../pi-rpc/client";
import { requireSuccess } from "../pi-rpc/response-data";
import {
  spawnPiRpcTransport,
  type PiProcessOptions,
} from "../pi-rpc/transport";
import type { PiAssistantMessage, PiRpcEvent } from "../pi-rpc/types";
import type { ExtractedMemoryEntry, MemoryExtractionJob } from "./types";

const MAX_TRANSCRIPT_CHARS = 256 * 1024;
const MAX_TRANSCRIPT_RANGE_BYTES = 64 * 1024 * 1024;
const MAX_EXTRACTED_ENTRIES = 64;

export interface MemoryExtractorOptions {
  command: string;
  cwd: string;
  sessionDir: string;
  model?: string;
  timeoutMs: number;
  logger?: InfoLogger;
  createClient?: () => PiRpcClientLike;
}

export function buildMemoryWorkerArgs(model?: string): string[] {
  return [
    "--no-session",
    "--no-extensions",
    "--no-tools",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    ...(model ? ["--model", model] : []),
  ];
}

export class MemoryExtractor {
  readonly #options: MemoryExtractorOptions;

  constructor(options: MemoryExtractorOptions) {
    this.#options = options;
  }

  async extract(
    job: MemoryExtractionJob,
    signal?: AbortSignal,
  ): Promise<ExtractedMemoryEntry[]> {
    if (signal?.aborted) {
      throw abortError();
    }
    const transcript = await readTranscript(job);
    if (transcript.length === 0) {
      return [];
    }

    const client = this.#options.createClient?.() ?? this.#createClient();
    const response = await runExtraction(
      client,
      extractionPrompt(transcript),
      this.#options.timeoutMs,
      signal,
    );
    return parseExtractionResult(response);
  }

  #createClient(): PiRpcClientLike {
    const processOptions: PiProcessOptions = {
      command: this.#options.command,
      cwd: this.#options.cwd,
      sessionDir: this.#options.sessionDir,
      args: buildMemoryWorkerArgs(this.#options.model),
    };
    return new PiRpcClient(
      spawnPiRpcTransport(processOptions),
      this.#options.logger,
    );
  }
}

async function runExtraction(
  client: PiRpcClientLike,
  prompt: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  let settled = false;
  let assistant: PiAssistantMessage | undefined;
  let resolveSettled: (() => void) | undefined;
  const completion = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  let rejectFailure: ((error: Error) => void) | undefined;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  const unsubscribe = client.onEvent((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      assistant = event.message;
    }
    if (event.type === "agent_settled") {
      settled = true;
      resolveSettled?.();
    }
  });
  const unsubscribeFatal = client.onFatal((error) => rejectFailure?.(error));
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
  const onAbort = (): void => rejectFailure?.(abortError());
  timeoutController.signal.addEventListener("abort", onAbort, { once: true });
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const promptResponse = await Promise.race([
      client.request({ type: "prompt", message: prompt }),
      failure,
    ]);
    requireSuccess(promptResponse, "prompt");
    if (!settled) {
      await Promise.race([completion, failure]);
    }
    if (
      !assistant ||
      (assistant.stopReason !== "stop" && assistant.stopReason !== "length")
    ) {
      throw new Error(
        "Memory extraction did not produce a final assistant response",
      );
    }
    const text = assistant.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("")
      .trim();
    if (!text) {
      throw new Error("Memory extraction returned an empty response");
    }
    return text;
  } finally {
    clearTimeout(timeout);
    timeoutController.signal.removeEventListener("abort", onAbort);
    signal?.removeEventListener("abort", onAbort);
    unsubscribe();
    unsubscribeFatal();
    await client.close();
  }
}

async function readTranscript(
  job: MemoryExtractionJob,
): Promise<Array<{ role: "user" | "assistant"; text: string }>> {
  const length = job.toOffset - job.fromOffset;
  if (length <= 0 || length > MAX_TRANSCRIPT_RANGE_BYTES) {
    throw new Error(
      "Memory extraction transcript range is invalid or too large",
    );
  }
  const handle = await open(job.sessionFile, "r");
  try {
    const sourceStat = await handle.stat();
    if (
      (job.sourceDevice !== undefined && sourceStat.dev !== job.sourceDevice) ||
      (job.sourceInode !== undefined && sourceStat.ino !== job.sourceInode)
    ) {
      throw new Error("Memory extraction session file identity changed");
    }
    const buffer = Buffer.alloc(length);
    const read = await handle.read(buffer, 0, length, job.fromOffset);
    if (read.bytesRead !== length) {
      throw new Error("Memory extraction transcript range is incomplete");
    }
    const source = buffer.toString("utf8");
    if (!source.endsWith("\n") || source.includes("\r")) {
      throw new Error("Memory extraction transcript is not strict LF JSONL");
    }
    const transcript: Array<{ role: "user" | "assistant"; text: string }> = [];
    let characters = 0;
    for (const line of source.slice(0, -1).split("\n")) {
      if (!line) {
        throw new Error(
          "Memory extraction transcript contains an empty JSONL line",
        );
      }
      const message = extractTranscriptMessage(JSON.parse(line) as unknown);
      if (!message) {
        continue;
      }
      const remaining = MAX_TRANSCRIPT_CHARS - characters;
      if (remaining <= 0) {
        break;
      }
      if (message.text.length > remaining) {
        const suffix = "\n[transcript truncated]";
        transcript.push({
          ...message,
          text:
            remaining > suffix.length
              ? `${message.text.slice(0, remaining - suffix.length)}${suffix}`
              : message.text.slice(0, remaining),
        });
        break;
      }
      characters += message.text.length;
      transcript.push(message);
    }
    return transcript;
  } finally {
    await handle.close();
  }
}

function extractTranscriptMessage(
  value: unknown,
): { role: "user" | "assistant"; text: string } | null {
  if (
    !isRecord(value) ||
    value.type !== "message" ||
    !isRecord(value.message)
  ) {
    return null;
  }
  const role = value.message.role;
  if (role !== "user" && role !== "assistant") {
    return null;
  }
  if (
    role === "assistant" &&
    value.message.stopReason !== "stop" &&
    value.message.stopReason !== "length"
  ) {
    return null;
  }
  const content = value.message.content;
  if (typeof content === "string") {
    return content.trim() ? { role, text: content } : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .filter(
      (item): item is { type: "text"; text: string } =>
        isRecord(item) && item.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n")
    .trim();
  return text ? { role, text } : null;
}

function extractionPrompt(
  transcript: Array<{ role: "user" | "assistant"; text: string }>,
): string {
  return [
    "Extract durable memory from the transcript JSON below.",
    "Return exactly one JSON object and no Markdown fences or commentary.",
    'Schema: {"version":1,"entries":[{"target":"long_term","content":"Markdown"}|{"target":"daily","decisions":["..."],"lessonsLearned":["..."],"notes":["..."],"followUps":["..."]}]}',
    "Use long_term only for durable user facts, explicit preferences, lasting decisions, and explicit requests to remember.",
    "For daily, return at most one structured session summary with concise bullet text in the four arrays.",
    "Use balanced filtering: keep meaningful outcomes, useful investigation findings, decisions, lessons, and active follow-ups.",
    "Do not record a request merely because the user made it. Skip routine tool calls, link-only requests, transient search steps, and low-value process details unless their result is useful later.",
    "Do not store secrets, credentials, tokens, raw tool output, or unsupported inferences.",
    "Return an empty entries array when nothing is worth storing.",
    "Transcript JSON:",
    JSON.stringify(transcript),
  ].join("\n");
}

function parseExtractionResult(text: string): ExtractedMemoryEntry[] {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error("Memory extraction response is not valid JSON", {
      cause: error,
    });
  }
  if (!isRecord(value)) {
    throw new Error("Memory extraction response must be an object");
  }
  assertOnlyKeys(value, ["version", "entries"]);
  if (value.version !== 1 || !Array.isArray(value.entries)) {
    throw new Error("Memory extraction response has an invalid schema");
  }
  if (value.entries.length > MAX_EXTRACTED_ENTRIES) {
    throw new Error("Memory extraction response contains too many entries");
  }
  const entries = value.entries.map((entry): ExtractedMemoryEntry => {
    if (!isRecord(entry)) {
      throw new Error("Memory extraction entry must be an object");
    }
    if (entry.target === "long_term") {
      assertOnlyKeys(entry, ["target", "content"]);
      if (
        typeof entry.content !== "string" ||
        !entry.content.trim() ||
        entry.content.length > 64 * 1024
      ) {
        throw new Error("Memory extraction entry has invalid content");
      }
      return { target: "long_term", content: entry.content };
    }
    if (entry.target !== "daily") {
      throw new Error("Memory extraction entry has an invalid target");
    }
    assertOnlyKeys(entry, [
      "target",
      "decisions",
      "lessonsLearned",
      "notes",
      "followUps",
    ]);
    const daily: ExtractedMemoryEntry = {
      target: "daily",
      decisions: parseSummaryItems(entry.decisions, "decisions"),
      lessonsLearned: parseSummaryItems(entry.lessonsLearned, "lessonsLearned"),
      notes: parseSummaryItems(entry.notes, "notes"),
      followUps: parseSummaryItems(entry.followUps, "followUps"),
    };
    const summaryItems = [
      ...daily.decisions,
      ...daily.lessonsLearned,
      ...daily.notes,
      ...daily.followUps,
    ];
    if (summaryItems.length === 0) {
      throw new Error("Daily memory extraction must not be empty");
    }
    if (summaryItems.join("\n").length > 64 * 1024) {
      throw new Error("Daily memory extraction is too large");
    }
    return daily;
  });
  if (entries.filter((entry) => entry.target === "daily").length > 1) {
    throw new Error("Memory extraction returned multiple daily summaries");
  }
  return entries;
}

function parseSummaryItems(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error(`Memory extraction ${name} must be an array`);
  }
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim() || item.length > 4 * 1024) {
      throw new Error(`Memory extraction ${name} contains an invalid item`);
    }
    return item.trim();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("Memory extraction response contains unknown fields");
  }
}

function abortError(): Error {
  const error = new Error("Memory extraction was aborted");
  error.name = "AbortError";
  return error;
}
