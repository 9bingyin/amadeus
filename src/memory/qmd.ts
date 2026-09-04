import { isAbsolute, relative, resolve } from "node:path";
import type { MemorySearchMode } from "../../plugins/memory/protocol";
import { MemoryStore } from "./store";
import type { MemoryOperationResult } from "./types";

const COLLECTION_NAME = "pi-memory";
const MAINTENANCE_TIMEOUT_MS = 60_000;

export interface QmdCommandResult {
  stdout: string;
  stderr: string;
}

export interface QmdCommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
  ): Promise<QmdCommandResult>;
}

export interface QmdCoordinatorOptions {
  store: MemoryStore;
  memoryDir: string;
  command: string;
  enabled: boolean;
  searchTimeoutMs: number;
  retryDelayMs?: number;
  runner?: QmdCommandRunner;
}

export class QmdCoordinator {
  readonly #store: MemoryStore;
  readonly #memoryDir: string;
  readonly #command: string;
  readonly #enabled: boolean;
  readonly #searchTimeoutMs: number;
  readonly #retryDelayMs: number;
  readonly #runner: QmdCommandRunner;
  #queue: Promise<void> = Promise.resolve();
  #maintenanceScheduled = false;
  #startupRefreshNeeded = false;
  #collectionReady = false;
  #stopping = false;
  #controller: AbortController | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: QmdCoordinatorOptions) {
    this.#store = options.store;
    this.#memoryDir = options.memoryDir;
    this.#command = options.command;
    this.#enabled = options.enabled;
    this.#searchTimeoutMs = options.searchTimeoutMs;
    this.#retryDelayMs = options.retryDelayMs ?? 30_000;
    this.#runner = options.runner ?? new BunQmdCommandRunner();
  }

  start(): void {
    const state = this.#store.getState();
    this.#startupRefreshNeeded =
      state.qmdUpdatedRevision === state.memoryRevision &&
      state.qmdEmbeddedRevision === state.memoryRevision;
    this.notifyMemoryRevision();
  }

  notifyMemoryRevision(): void {
    if (!this.#enabled || this.#stopping || this.#maintenanceScheduled) {
      return;
    }
    this.#maintenanceScheduled = true;
    const task = this.#queue.then(async () => {
      this.#maintenanceScheduled = false;
      await this.#maintain();
    });
    this.#queue = task.catch(() => {
      this.#maintenanceScheduled = false;
      this.#scheduleRetry();
    });
  }

  async search(
    query: string,
    mode: MemorySearchMode,
    limit: number,
  ): Promise<MemoryOperationResult> {
    if (mode === "keyword" || !this.#enabled || this.#stopping) {
      return this.#fallbackSearch(query, limit, mode !== "keyword");
    }
    const state = this.#store.getState();
    if (
      state.qmdUpdatedRevision < state.memoryRevision ||
      state.qmdEmbeddedRevision < state.memoryRevision
    ) {
      this.notifyMemoryRevision();
      return this.#fallbackSearch(query, limit, true);
    }

    try {
      return await this.#enqueueSearch(async (signal) => {
        const subcommand = mode === "semantic" ? "vsearch" : "query";
        const result = await this.#runner.run(
          this.#command,
          [
            subcommand,
            "--json",
            "-c",
            COLLECTION_NAME,
            "-n",
            String(limit),
            query,
          ],
          {
            cwd: this.#memoryDir,
            timeoutMs: this.#searchTimeoutMs,
            signal,
          },
        );
        return {
          content: formatSearchResult(result.stdout, this.#memoryDir),
        };
      });
    } catch {
      this.#collectionReady = false;
      this.notifyMemoryRevision();
      return this.#fallbackSearch(query, limit, true);
    }
  }

  async close(): Promise<void> {
    this.#stopping = true;
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
    this.#controller?.abort();
    await this.#queue.catch(() => undefined);
  }

  async #maintain(): Promise<void> {
    if (this.#stopping) {
      return;
    }
    this.#controller = new AbortController();
    const signal = this.#controller.signal;
    try {
      await this.#ensureCollection(signal);
      if (this.#startupRefreshNeeded && !this.#stopping) {
        const targetRevision = this.#store.getState().memoryRevision;
        await this.#runner.run(this.#command, ["update"], {
          cwd: this.#memoryDir,
          timeoutMs: MAINTENANCE_TIMEOUT_MS,
          signal,
        });
        await this.#store.updateQmdWatermarks({
          updatedRevision: targetRevision,
        });
        await this.#runner.run(this.#command, ["embed"], {
          cwd: this.#memoryDir,
          timeoutMs: MAINTENANCE_TIMEOUT_MS,
          signal,
        });
        await this.#store.updateQmdWatermarks({
          embeddedRevision: targetRevision,
        });
        this.#startupRefreshNeeded = false;
      }
      while (!this.#stopping) {
        const state = this.#store.getState();
        if (state.qmdUpdatedRevision < state.memoryRevision) {
          const targetRevision = state.memoryRevision;
          await this.#runner.run(this.#command, ["update"], {
            cwd: this.#memoryDir,
            timeoutMs: MAINTENANCE_TIMEOUT_MS,
            signal,
          });
          await this.#store.updateQmdWatermarks({
            updatedRevision: targetRevision,
          });
          continue;
        }
        if (state.qmdEmbeddedRevision < state.memoryRevision) {
          const targetRevision = state.memoryRevision;
          await this.#runner.run(this.#command, ["embed"], {
            cwd: this.#memoryDir,
            timeoutMs: MAINTENANCE_TIMEOUT_MS,
            signal,
          });
          await this.#store.updateQmdWatermarks({
            embeddedRevision: targetRevision,
          });
          continue;
        }
        return;
      }
    } finally {
      this.#controller = undefined;
    }
  }

  async #ensureCollection(signal: AbortSignal): Promise<void> {
    if (this.#collectionReady) {
      return;
    }
    const result = await this.#runner.run(
      this.#command,
      ["collection", "list", "--json"],
      {
        cwd: this.#memoryDir,
        timeoutMs: MAINTENANCE_TIMEOUT_MS,
        signal,
      },
    );
    if (
      !containsCollection(
        parseQmdJson(result.stdout),
        COLLECTION_NAME,
        this.#memoryDir,
      )
    ) {
      await this.#runner.run(
        this.#command,
        ["collection", "add", this.#memoryDir, "--name", COLLECTION_NAME],
        {
          cwd: this.#memoryDir,
          timeoutMs: MAINTENANCE_TIMEOUT_MS,
          signal,
        },
      );
    }
    this.#collectionReady = true;
  }

  async #fallbackSearch(
    query: string,
    limit: number,
    degraded: boolean,
  ): Promise<MemoryOperationResult> {
    const result = await this.#store.read({
      toolName: "memory_search",
      query,
      mode: "keyword",
      limit,
    });
    return degraded
      ? {
          ...result,
          content: `qmd is not current; using keyword fallback.\n${result.content}`,
        }
      : result;
  }

  async #enqueueSearch<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    let resolveResult: ((value: T) => void) | undefined;
    let rejectResult: ((error: unknown) => void) | undefined;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const task = this.#queue.then(async () => {
      try {
        if (this.#stopping) {
          throw new Error("qmd coordinator is shutting down");
        }
        this.#controller = new AbortController();
        resolveResult?.(await operation(this.#controller.signal));
      } catch (error) {
        rejectResult?.(error);
      } finally {
        this.#controller = undefined;
      }
    });
    this.#queue = task.catch(() => undefined);
    return result;
  }

  #scheduleRetry(): void {
    if (this.#stopping || this.#retryTimer) {
      return;
    }
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      this.notifyMemoryRevision();
    }, this.#retryDelayMs);
  }
}

export class BunQmdCommandRunner implements QmdCommandRunner {
  async run(
    command: string,
    args: readonly string[],
    options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
  ): Promise<QmdCommandResult> {
    if (options.signal?.aborted) {
      throw abortError();
    }
    const subprocess = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    const abort = (): void => subprocess.kill(9);
    controller.signal.addEventListener("abort", abort, { once: true });
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited,
      ]);
      if (controller.signal.aborted) {
        throw abortError();
      }
      if (exitCode !== 0) {
        throw new Error(`qmd command failed with status ${exitCode}`);
      }
      return { stdout, stderr };
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", abort);
      options.signal?.removeEventListener("abort", onAbort);
      if (controller.signal.aborted) {
        subprocess.kill(9);
      }
    }
  }
}

function containsCollection(
  value: unknown,
  name: string,
  memoryDir: string,
): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsCollection(item, name, memoryDir));
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = Object.fromEntries(Object.entries(value));
  if (record.name === name) {
    const configuredPath = firstString(record, [
      "path",
      "root",
      "directory",
      "source",
    ]);
    return (
      configuredPath.length > 0 &&
      resolve(configuredPath) === resolve(memoryDir)
    );
  }
  return Object.values(record).some((item) =>
    containsCollection(item, name, memoryDir),
  );
}

function parseQmdJson(stdout: string): unknown {
  const lines = stdout
    .replace(/\u001b\[[0-9;]*m/g, "")
    .trim()
    .split("\n");
  const start = lines.findIndex((line) => {
    const trimmed = line.trimStart();
    return trimmed.startsWith("[") || trimmed.startsWith("{");
  });
  if (start < 0) {
    throw new Error("qmd output does not contain JSON");
  }
  return JSON.parse(lines.slice(start).join("\n")) as unknown;
}

function formatSearchResult(stdout: string, memoryDir: string): string {
  const value = parseQmdJson(stdout);
  const items = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.results)
      ? value.results
      : isRecord(value) && Array.isArray(value.hits)
        ? value.hits
        : [];
  if (items.length === 0) {
    return "No matching memory found.";
  }
  const lines = items.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const rawPath = firstString(item, ["path", "file", "source"]);
    if (!rawPath) {
      return [];
    }
    const path = safeMemoryResultPath(rawPath, memoryDir);
    if (!path) {
      return [];
    }
    const text = firstString(item, ["snippet", "text", "content", "chunk"]);
    return text ? [`${path}\n${text}`] : [];
  });
  if (lines.length === 0) {
    return "No matching memory found.";
  }
  const content = lines
    .map((line, index) => `${index + 1}. ${line}`)
    .join("\n\n");
  return content.length <= 64 * 1024
    ? content
    : `${content.slice(0, 64 * 1024 - 18)}\n[output truncated]`;
}

function safeMemoryResultPath(value: string, memoryDir: string): string {
  if (!value) {
    return "";
  }
  const uriPrefix = `qmd://${COLLECTION_NAME}/`;
  const candidate = value.startsWith(uriPrefix)
    ? value.slice(uriPrefix.length)
    : value;
  const relativePath = isAbsolute(candidate)
    ? relative(memoryDir, candidate)
    : candidate.replace(/^\.\//, "");
  if (
    relativePath === MEMORY_FILE_NAME ||
    relativePath === SCRATCHPAD_FILE_NAME ||
    /^daily\/\d{4}-\d{2}-\d{2}\.md$/.test(relativePath)
  ) {
    return relativePath;
  }
  return "";
}

const MEMORY_FILE_NAME = "MEMORY.md";
const SCRATCHPAD_FILE_NAME = "SCRATCHPAD.md";

function firstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortError(): Error {
  const error = new Error("qmd command was aborted");
  error.name = "AbortError";
  return error;
}
