import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { MemorySearchMode } from "../../plugins/memory/protocol";
import type { InfoLogger } from "../logging/logger";
import { errorName, noopInfoLogger } from "../logging/logger";
import { MemoryStore } from "./store";
import type { MemoryOperationResult } from "./types";

const COLLECTION_NAME = "pi-memory";
const MAINTENANCE_TIMEOUT_MS = 60_000;

type QmdMaintenanceOperation =
  "collection_check" | "collection_add" | "update" | "embed";

type QmdMaintenanceFailureReason =
  | "collection_output_invalid"
  | "collection_path_mismatch"
  | "command_failed"
  | "command_aborted"
  | "unexpected_failure";

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
  logger?: InfoLogger;
}

export class QmdCoordinator {
  readonly #store: MemoryStore;
  readonly #memoryDir: string;
  readonly #command: string;
  readonly #enabled: boolean;
  readonly #searchTimeoutMs: number;
  readonly #retryDelayMs: number;
  readonly #runner: QmdCommandRunner;
  readonly #logger: InfoLogger;
  #queue: Promise<void> = Promise.resolve();
  #maintenanceScheduled = false;
  #startupRefreshPhase: "update" | "embed" | undefined;
  #collectionReady = false;
  #stopping = false;
  #controller: AbortController | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #maintenanceOperation: QmdMaintenanceOperation = "collection_check";
  #lastFailure:
    | {
        key: string;
        operation: QmdMaintenanceOperation;
      }
    | undefined;

  constructor(options: QmdCoordinatorOptions) {
    this.#store = options.store;
    this.#memoryDir = options.memoryDir;
    this.#command = options.command;
    this.#enabled = options.enabled;
    this.#searchTimeoutMs = options.searchTimeoutMs;
    this.#retryDelayMs = options.retryDelayMs ?? 30_000;
    this.#runner = options.runner ?? new BunQmdCommandRunner();
    this.#logger = options.logger ?? noopInfoLogger;
  }

  start(): void {
    const state = this.#store.getState();
    this.#startupRefreshPhase =
      state.qmdUpdatedRevision === state.memoryRevision &&
      state.qmdEmbeddedRevision === state.memoryRevision
        ? "update"
        : undefined;
    this.notifyMemoryRevision();
  }

  notifyMemoryRevision(): void {
    if (!this.#enabled || this.#stopping || this.#maintenanceScheduled) {
      return;
    }
    this.#maintenanceScheduled = true;
    const task = this.#queue.then(async () => {
      this.#maintenanceScheduled = false;
      if (await this.#maintain()) {
        this.#recordMaintenanceRecovery();
      }
    });
    this.#queue = task.catch((error: unknown) => {
      this.#maintenanceScheduled = false;
      this.#recordMaintenanceFailure(error);
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
      this.#startupRefreshPhase !== undefined ||
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

  async #maintain(): Promise<boolean> {
    if (this.#stopping) {
      return false;
    }
    this.#controller = new AbortController();
    const signal = this.#controller.signal;
    try {
      await this.#ensureCollection(signal);
      if (this.#startupRefreshPhase === "update" && !this.#stopping) {
        await this.#runMaintenanceCommand("update", ["update"], signal);
        this.#startupRefreshPhase = "embed";
      }
      if (this.#startupRefreshPhase === "embed" && !this.#stopping) {
        await this.#runMaintenanceCommand("embed", ["embed"], signal);
        this.#startupRefreshPhase = undefined;
      }
      while (!this.#stopping) {
        const state = this.#store.getState();
        if (state.qmdUpdatedRevision < state.memoryRevision) {
          const targetRevision = state.memoryRevision;
          await this.#runMaintenanceCommand("update", ["update"], signal);
          await this.#store.updateQmdWatermarks({
            updatedRevision: targetRevision,
          });
          continue;
        }
        if (state.qmdEmbeddedRevision < state.memoryRevision) {
          const targetRevision = state.memoryRevision;
          await this.#runMaintenanceCommand("embed", ["embed"], signal);
          await this.#store.updateQmdWatermarks({
            embeddedRevision: targetRevision,
          });
          continue;
        }
        return true;
      }
      return false;
    } finally {
      this.#controller = undefined;
    }
  }

  async #ensureCollection(signal: AbortSignal): Promise<void> {
    if (this.#collectionReady) {
      return;
    }
    let configuredPath = await this.#showCollection(signal);
    if (configuredPath === undefined) {
      await this.#runMaintenanceCommand(
        "collection_add",
        ["collection", "add", this.#memoryDir, "--name", COLLECTION_NAME],
        signal,
      );
      configuredPath = await this.#showCollection(signal);
      if (configuredPath === undefined) {
        throw new QmdCollectionOutputError(
          "qmd collection was not available after creation",
        );
      }
    }
    const [configuredRealPath, memoryRealPath] = await Promise.all([
      canonicalCollectionPath(configuredPath, this.#memoryDir),
      canonicalCollectionPath(this.#memoryDir, this.#memoryDir),
    ]);
    if (configuredRealPath !== memoryRealPath) {
      throw new QmdCollectionPathMismatchError();
    }
    this.#collectionReady = true;
  }

  async #showCollection(signal: AbortSignal): Promise<string | undefined> {
    try {
      const result = await this.#runMaintenanceCommand(
        "collection_check",
        ["collection", "show", COLLECTION_NAME],
        signal,
      );
      return parseCollectionShow(result.stdout, COLLECTION_NAME);
    } catch (error) {
      if (isCollectionNotFoundError(error, COLLECTION_NAME)) {
        return undefined;
      }
      throw error;
    }
  }

  #runMaintenanceCommand(
    operation: QmdMaintenanceOperation,
    args: readonly string[],
    signal: AbortSignal,
  ): Promise<QmdCommandResult> {
    this.#maintenanceOperation = operation;
    return this.#runner.run(this.#command, args, {
      cwd: this.#memoryDir,
      timeoutMs: MAINTENANCE_TIMEOUT_MS,
      signal,
    });
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

  #recordMaintenanceFailure(error: unknown): void {
    if (this.#stopping && errorName(error) === "AbortError") {
      return;
    }
    const operation = this.#maintenanceOperation;
    const failureName = errorName(error);
    const reason = maintenanceFailureReason(error);
    const exitCode =
      error instanceof QmdCommandError ? error.exitCode : undefined;
    const key = `${operation}:${failureName}:${reason}:${exitCode ?? ""}`;
    if (this.#lastFailure?.key === key) {
      return;
    }
    this.#lastFailure = { key, operation };
    this.#logger.info("memory_qmd_maintenance_failed", {
      operation,
      error_name: failureName,
      reason,
      retry_delay_ms: this.#retryDelayMs,
      ...(exitCode === undefined ? {} : { exit_code: exitCode }),
    });
  }

  #recordMaintenanceRecovery(): void {
    const previous = this.#lastFailure;
    if (!previous) {
      return;
    }
    this.#lastFailure = undefined;
    this.#logger.info("memory_qmd_maintenance_recovered", {
      previous_operation: previous.operation,
    });
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

export class QmdCommandError extends Error {
  readonly exitCode: number;
  readonly stderr: string;

  constructor(exitCode: number, stderr: string) {
    super(`qmd command failed with status ${exitCode}`);
    this.name = "QmdCommandError";
    this.exitCode = exitCode;
    this.stderr = stderr;
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
        throw new QmdCommandError(exitCode, stderr);
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

class QmdCollectionOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QmdCollectionOutputError";
  }
}

class QmdCollectionPathMismatchError extends Error {
  constructor(options?: ErrorOptions) {
    super("qmd collection path does not match memory directory", options);
    this.name = "QmdCollectionPathMismatchError";
  }
}

function parseCollectionShow(stdout: string, name: string): string {
  const lines = stripAnsi(stdout).split("\n");
  const collectionLines = lines
    .map((line) => /^\s*Collection:\s*(.+?)\s*$/.exec(line)?.[1])
    .filter((value): value is string => value !== undefined);
  const pathLines = lines
    .map((line) => /^\s*Path:\s*(.+?)\s*$/.exec(line)?.[1])
    .filter((value): value is string => value !== undefined);
  if (
    collectionLines.length !== 1 ||
    collectionLines[0] !== name ||
    pathLines.length !== 1 ||
    !pathLines[0]
  ) {
    throw new QmdCollectionOutputError(
      "qmd collection show returned unexpected output",
    );
  }
  return pathLines[0];
}

async function canonicalCollectionPath(
  configuredPath: string,
  cwd: string,
): Promise<string> {
  const expanded =
    configuredPath === "~"
      ? homedir()
      : configuredPath.startsWith("~/")
        ? join(homedir(), configuredPath.slice(2))
        : configuredPath;
  try {
    return await realpath(resolve(cwd, expanded));
  } catch (error) {
    throw new QmdCollectionPathMismatchError({ cause: error });
  }
}

function isCollectionNotFoundError(error: unknown, name: string): boolean {
  if (!(error instanceof QmdCommandError) || error.exitCode !== 1) {
    return false;
  }
  const expected = `Collection not found: ${name}`;
  return stripAnsi(error.stderr).trim() === expected;
}

function maintenanceFailureReason(error: unknown): QmdMaintenanceFailureReason {
  if (error instanceof QmdCollectionOutputError) {
    return "collection_output_invalid";
  }
  if (error instanceof QmdCollectionPathMismatchError) {
    return "collection_path_mismatch";
  }
  if (error instanceof QmdCommandError) {
    return "command_failed";
  }
  if (errorName(error) === "AbortError") {
    return "command_aborted";
  }
  return "unexpected_failure";
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
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
