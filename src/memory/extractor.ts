import { open } from "node:fs/promises";
import type { InfoLogger } from "../logging/logger";
import { PiRpcClient, type PiRpcClientLike } from "../pi-rpc/client";
import { requireSuccess } from "../pi-rpc/response-data";
import {
  spawnPiRpcTransport,
  type PiProcessOptions,
} from "../pi-rpc/transport";
import type { PiAssistantMessage, PiRpcEvent } from "../pi-rpc/types";
import {
  buildExitSummaryPrompt,
  EXIT_SUMMARY_MIN_MESSAGES,
  EXIT_SUMMARY_SYSTEM_PROMPT,
  parseExitSummary,
  SessionConversationBuilder,
  truncateConversationForSummary,
} from "./exit-summary";
import type { ExtractedMemoryEntry, MemoryExtractionJob } from "./types";

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
    "--system-prompt",
    EXIT_SUMMARY_SYSTEM_PROMPT,
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
    const transcript = await readTranscript(job, signal);
    if (transcript.messageCount < EXIT_SUMMARY_MIN_MESSAGES) {
      return [];
    }
    if (!transcript.conversation.text) {
      return [];
    }

    const client = this.#options.createClient?.() ?? this.#createClient();
    const response = await runExtraction(
      client,
      buildExitSummaryPrompt(
        transcript.conversation.text,
        transcript.conversation.truncated,
        transcript.conversation.totalChars,
      ),
      this.#options.timeoutMs,
      signal,
    );
    const summary = parseExitSummary(response);
    return summary ? [{ target: "daily", content: summary }] : [];
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
  signal?: AbortSignal,
): Promise<{
  messageCount: number;
  conversation: { text: string; truncated: boolean; totalChars: number };
}> {
  if (job.toOffset <= 0) {
    throw new Error("Memory extraction transcript range is invalid");
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
    if (sourceStat.size < job.toOffset) {
      throw new Error("Memory extraction transcript range is incomplete");
    }

    const decoder = new TextDecoder("utf-8", { fatal: true });
    const buffer = Buffer.alloc(64 * 1024);
    let pending = "";
    let position = 0;
    const builder = new SessionConversationBuilder();

    while (position < job.toOffset) {
      if (signal?.aborted) {
        throw abortError();
      }
      const length = Math.min(buffer.length, job.toOffset - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) {
        throw new Error("Memory extraction transcript range is incomplete");
      }
      pending += decoder.decode(buffer.subarray(0, bytesRead), {
        stream: true,
      });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        builder.pushJsonlLine(line);
      }
      position += bytesRead;
    }
    pending += decoder.decode();
    if (pending) {
      throw new Error("Memory extraction transcript is not strict LF JSONL");
    }

    const serialized = builder.finish();
    return {
      messageCount: serialized.messageCount,
      conversation: truncateConversationForSummary(serialized.conversation),
    };
  } finally {
    await handle.close();
  }
}

function abortError(): Error {
  const error = new Error("Memory extraction was aborted");
  error.name = "AbortError";
  return error;
}
