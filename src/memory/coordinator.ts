import type {
  MemorySnapshotResult,
  MemoryToolArguments,
  MemoryToolResult,
} from "../../plugins/memory/protocol";
import type { PiMemoryRequest } from "../bridge/chat-agent";
import { MemoryStore } from "./store";
import type {
  ExtractedMemoryEntry,
  MemoryExtractionJob,
  MemoryOperationResult,
} from "./types";

const MAX_EXTRACTION_ATTEMPTS = 5;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1_000;

export interface MemoryExtractionRunner {
  extract(
    job: MemoryExtractionJob,
    signal?: AbortSignal,
  ): Promise<ExtractedMemoryEntry[]>;
}

export interface MemorySearchCoordinator {
  notifyMemoryRevision(): void;
  search(
    query: string,
    mode: "keyword" | "semantic" | "deep",
    limit: number,
  ): Promise<MemoryOperationResult>;
}

export interface MemoryCoordinatorOptions {
  store: MemoryStore;
  extractor: MemoryExtractionRunner;
  qmd?: MemorySearchCoordinator;
  retryDelayMs?: number;
  now?: () => number;
}

export class MemoryCoordinator {
  readonly #store: MemoryStore;
  readonly #extractor: MemoryExtractionRunner;
  readonly #qmd: MemorySearchCoordinator | undefined;
  readonly #retryDelayMs: number;
  readonly #now: () => number;
  readonly #ipcTasks = new Set<Promise<unknown>>();
  #acceptingIpc = true;
  #workerStopped = false;
  #work: Promise<void> | undefined;
  #workerController: AbortController | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: MemoryCoordinatorOptions) {
    this.#store = options.store;
    this.#extractor = options.extractor;
    this.#qmd = options.qmd;
    this.#retryDelayMs = options.retryDelayMs ?? 5_000;
    this.#now = options.now ?? Date.now;
  }

  start(): void {
    if (!this.#workerStopped) {
      this.#wakeWorker();
    }
  }

  handleRequest(
    request: PiMemoryRequest,
  ): Promise<MemorySnapshotResult | MemoryToolResult> {
    if (request.kind === "snapshot") {
      const snapshot = this.#store.getSnapshot();
      return Promise.resolve({
        version: 1,
        status: "ready",
        revision: snapshot.revision,
        content: snapshot.content,
      });
    }
    if (!this.#acceptingIpc) {
      return Promise.resolve({
        version: 1,
        status: "rejected",
        code: "shutting_down",
        message: "Amadeus memory is shutting down",
      });
    }

    const task = this.#executeTool(request);
    this.#ipcTasks.add(task);
    void task.finally(() => this.#ipcTasks.delete(task)).catch(() => undefined);
    return task;
  }

  async checkpointSession(input: {
    chatId: number;
    sessionId: string;
    sessionFile: string;
  }): Promise<void> {
    if (!this.#acceptingIpc) {
      throw new Error("Memory coordinator is shutting down");
    }
    await this.#store.captureSessionRange(input);
    this.#wakeWorker();
  }

  async processNextJob(
    signal?: AbortSignal,
  ): Promise<"processed" | "retry" | "idle"> {
    const job = await this.#store.claimNextJob(this.#now());
    if (!job) {
      return "idle";
    }
    try {
      const entries = await this.#extractor.extract(job, signal);
      await this.#store.completeExtractionJob(job, entries);
      if (entries.length > 0) {
        this.#qmd?.notifyMemoryRevision();
      }
      return "processed";
    } catch (error) {
      if (signal?.aborted || this.#workerStopped) {
        throw error;
      }
      if (job.attempts >= MAX_EXTRACTION_ATTEMPTS) {
        await this.#store.failJob(job.id);
        return "processed";
      }
      const retryDelay = Math.min(
        this.#retryDelayMs * 2 ** (job.attempts - 1),
        MAX_RETRY_DELAY_MS,
      );
      await this.#store.retryJob(job.id, this.#now() + retryDelay);
      return "retry";
    }
  }

  async beginShutdown(): Promise<void> {
    if (this.#workerStopped) {
      await this.#work?.catch(() => undefined);
      return;
    }
    this.#workerStopped = true;
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
    this.#workerController?.abort();
    await this.#work?.catch(() => undefined);
  }

  async close(): Promise<void> {
    if (!this.#acceptingIpc) {
      await this.#work?.catch(() => undefined);
      return;
    }
    this.#acceptingIpc = false;
    await Promise.allSettled(this.#ipcTasks);
    await this.beginShutdown();
  }

  async #executeTool(
    request: Extract<PiMemoryRequest, { kind: "tool" }>,
  ): Promise<MemoryToolResult> {
    const receiptId = `memory:${request.sessionId}:${request.toolCallId}`;
    try {
      const mutation = isMutation(request.args);
      const result = mutation
        ? await this.#store.executeMutation(receiptId, request.args)
        : request.args.toolName === "memory_search" && this.#qmd
          ? await this.#qmd.search(
              request.args.query,
              request.args.mode ?? "keyword",
              request.args.limit ?? 10,
            )
          : await this.#store.read(request.args);
      if (mutation) {
        this.#qmd?.notifyMemoryRevision();
      }
      return {
        version: 1,
        status: "completed",
        receiptId,
        content: result.content,
        ...(result.isError ? { isError: true } : {}),
      };
    } catch {
      return isMutation(request.args)
        ? {
            version: 1,
            status: "unknown",
            code: "host_failure",
            message: "The memory operation outcome cannot be confirmed",
          }
        : {
            version: 1,
            status: "rejected",
            code: "host_failure",
            message: "The memory operation failed",
          };
    }
  }

  #wakeWorker(): void {
    if (this.#workerStopped || this.#work) {
      return;
    }
    this.#workerController = new AbortController();
    const signal = this.#workerController.signal;
    this.#work = this.#runWorker(signal).finally(() => {
      this.#work = undefined;
      this.#workerController = undefined;
    });
    void this.#work.catch(() => undefined);
  }

  async #runWorker(signal: AbortSignal): Promise<void> {
    let retryNeeded = false;
    while (!this.#workerStopped && !signal.aborted) {
      const result = await this.processNextJob(signal);
      if (result === "retry") {
        retryNeeded = true;
        continue;
      }
      if (result === "idle") {
        if (retryNeeded) {
          this.#retryTimer = setTimeout(() => {
            this.#retryTimer = undefined;
            this.#wakeWorker();
          }, this.#retryDelayMs);
        }
        return;
      }
    }
  }
}

function isMutation(args: MemoryToolArguments): boolean {
  return (
    args.toolName === "memory_write" ||
    args.toolName === "memory_forget" ||
    args.toolName === "memory_restore" ||
    (args.toolName === "scratchpad" && args.action !== "list")
  );
}
