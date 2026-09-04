import {
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  MEMORY_CONTENT_MAX_CHARS,
  MEMORY_SNAPSHOT_MAX_CHARS,
  type MemoryToolArguments,
} from "../../plugins/memory/protocol";
import type {
  ExtractedMemoryEntry,
  MemoryCheckpoint,
  MemoryCheckpointNode,
  MemoryCheckpointRange,
  MemoryExtractionJob,
  MemoryOperationResult,
  MemoryRecoveryRecord,
  MemorySnapshot,
  MemoryState,
} from "./types";

const STATE_FILE = "state.json";
const MEMORY_FILE = "MEMORY.md";
const SCRATCHPAD_FILE = "SCRATCHPAD.md";
const RECEIPT_VERSION = 1;
const CHECKPOINT_RANGE_TARGET_BYTES = 256 * 1024;
const SESSION_HEADER_MAX_BYTES = 64 * 1024;
const RECOVERY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAILY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SCRATCHPAD_ITEM_PATTERN = /^- \[([ xX])\] (.+)$/;
const GENERATED_ENTRY_PATTERN =
  /^<!-- (?:(?:last updated: )?\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}|HANDOFF \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[[^\]\r\n]+\] -->$/;

interface PreparedReceipt {
  version: 1;
  status: "prepared";
  receiptId: string;
  revision: number;
  writes: Array<{ relativePath: string; content: string }>;
  result: MemoryOperationResult;
}

interface CompletedReceipt {
  version: 1;
  status: "completed";
  receiptId: string;
  revision: number;
  result: MemoryOperationResult;
}

type Receipt = PreparedReceipt | CompletedReceipt;

export interface MemoryStoreOptions {
  memoryDir: string;
  stateDir: string;
  now?: () => Date;
  createId?: () => string;
}

export interface CaptureSessionRangeInput {
  chatId: number;
  sessionId: string;
  sessionFile: string;
}

export class MemoryStore {
  readonly #memoryDir: string;
  readonly #metadataDir: string;
  readonly #jobsDir: string;
  readonly #failedJobsDir: string;
  readonly #checkpointsDir: string;
  readonly #checkpointRangesDir: string;
  readonly #receiptsDir: string;
  readonly #now: () => Date;
  readonly #createId: () => string;
  #state: MemoryState;
  #snapshot: MemorySnapshot;
  #operationQueue: Promise<void> = Promise.resolve();
  #checkpointOperationQueue: Promise<void> = Promise.resolve();
  #snapshotRefreshEnabled = false;
  #snapshotDirty = false;
  #contentGeneration = 0;
  #snapshotWork: Promise<void> | undefined;
  #snapshotController: AbortController | undefined;
  #checkpointPromotionWork: Promise<number> | undefined;

  private constructor(
    options: MemoryStoreOptions,
    state: MemoryState,
    snapshot: MemorySnapshot,
  ) {
    this.#memoryDir = resolve(options.memoryDir);
    this.#metadataDir = resolve(options.stateDir);
    this.#jobsDir = join(this.#metadataDir, "jobs");
    this.#failedJobsDir = join(this.#jobsDir, "failed");
    this.#checkpointsDir = join(this.#metadataDir, "checkpoints");
    this.#checkpointRangesDir = join(this.#checkpointsDir, "ranges");
    this.#receiptsDir = join(this.#metadataDir, "receipts");
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#state = state;
    this.#snapshot = snapshot;
  }

  static async open(options: MemoryStoreOptions): Promise<MemoryStore> {
    if (!isAbsolute(options.memoryDir) || !isAbsolute(options.stateDir)) {
      throw new Error("Memory store paths must be absolute");
    }
    const configuredMemoryDir = resolve(options.memoryDir);
    const configuredMetadataDir = resolve(options.stateDir);
    await Promise.all([
      mkdir(join(configuredMemoryDir, "daily"), { recursive: true }),
      mkdir(join(configuredMemoryDir, "recovery"), { recursive: true }),
      mkdir(join(configuredMetadataDir, "jobs", "failed"), {
        recursive: true,
      }),
      mkdir(join(configuredMetadataDir, "checkpoints", "ranges"), {
        recursive: true,
      }),
      mkdir(join(configuredMetadataDir, "receipts"), { recursive: true }),
    ]);
    await Promise.all(
      [
        dirname(configuredMemoryDir),
        dirname(configuredMetadataDir),
        configuredMemoryDir,
        configuredMetadataDir,
        join(configuredMetadataDir, "checkpoints"),
        join(configuredMetadataDir, "jobs"),
      ].map(syncDirectory),
    );
    const [memoryDir, metadataDir] = await Promise.all([
      realpath(configuredMemoryDir),
      realpath(configuredMetadataDir),
    ]);
    await Promise.all([
      assertCanonicalDirectory(memoryDir, "daily"),
      assertCanonicalDirectory(memoryDir, "recovery"),
      assertCanonicalDirectory(metadataDir, "jobs"),
      assertCanonicalDirectory(metadataDir, "jobs/failed"),
      assertCanonicalDirectory(metadataDir, "checkpoints"),
      assertCanonicalDirectory(metadataDir, "checkpoints/ranges"),
      assertCanonicalDirectory(metadataDir, "receipts"),
    ]);
    await ensureFile(join(memoryDir, MEMORY_FILE), "");
    await ensureFile(join(memoryDir, SCRATCHPAD_FILE), "# Scratchpad\n");

    const statePath = join(metadataDir, STATE_FILE);
    const state = await readOptionalJson(statePath, parseMemoryState);
    const initialRevision = state
      ? state.memoryRevision
      : (await hasExistingMemoryContent(memoryDir))
        ? 1
        : 0;
    const initialState =
      state ??
      ({
        version: 1,
        memoryRevision: initialRevision,
        qmdUpdatedRevision: 0,
        qmdEmbeddedRevision: 0,
      } satisfies MemoryState);
    if (!state) {
      await atomicWriteJson(statePath, initialState);
    }

    const store = new MemoryStore(
      {
        ...options,
        memoryDir,
        stateDir: metadataDir,
      },
      initialState,
      {
        revision: initialState.memoryRevision,
        content: "",
      },
    );
    await store.#migrateLegacyCheckpoints();
    await store.#recoverPreparedReceipts();
    await store.#recoverRunningJobs();
    await store.#refreshSnapshot();
    store.#snapshotRefreshEnabled = true;
    return store;
  }

  getSnapshot(): MemorySnapshot {
    return { ...this.#snapshot };
  }

  async waitForSnapshot(): Promise<void> {
    while (this.#snapshotWork) {
      await this.#snapshotWork;
    }
  }

  async close(): Promise<void> {
    this.#snapshotRefreshEnabled = false;
    this.#snapshotController?.abort();
    while (this.#snapshotWork) {
      await this.#snapshotWork.catch(() => undefined);
    }
  }

  getMemoryDir(): string {
    return this.#memoryDir;
  }

  getState(): MemoryState {
    return { ...this.#state };
  }

  async captureSessionRange(
    input: CaptureSessionRangeInput,
  ): Promise<MemoryCheckpointRange | null> {
    return this.#serializeCheckpoint(async () => {
      requireSafeInteger(input.chatId, "chatId", 1);
      requireNonEmpty(input.sessionId, "sessionId");
      if (!isAbsolute(input.sessionFile)) {
        throw new Error("sessionFile must be absolute");
      }
      const sessionFile = await realpath(input.sessionFile);
      const fileStat = await stat(sessionFile);
      if (!fileStat.isFile()) {
        throw new Error("sessionFile must be a regular file");
      }
      const toOffset = fileStat.size;
      const checkpointPath = this.#checkpointPath(input.chatId);
      const checkpoint =
        (await readOptionalJson(checkpointPath, parseMemoryCheckpoint)) ??
        ({
          version: 1,
          chatId: input.chatId,
        } satisfies MemoryCheckpoint);
      if (checkpoint.chatId !== input.chatId) {
        throw new Error("Memory checkpoint chatId mismatch");
      }
      await assertSessionHeader(sessionFile, input.sessionId, toOffset);
      const fromOffset =
        checkpoint.cursor?.sessionId === input.sessionId &&
        checkpoint.cursor.sessionFile === sessionFile &&
        checkpoint.cursor.sourceDevice === fileStat.dev &&
        checkpoint.cursor.sourceInode === fileStat.ino
          ? checkpoint.cursor.offset
          : 0;
      if (toOffset < fromOffset) {
        throw new Error("Session file shrank below the stored checkpoint");
      }
      await assertJsonlBoundary(sessionFile, fromOffset, toOffset);
      if (toOffset === fromOffset) {
        return null;
      }

      const range: MemoryCheckpointRange = {
        id: extractionJobId(
          input.chatId,
          input.sessionId,
          fileStat.dev,
          fileStat.ino,
          fromOffset,
          toOffset,
        ),
        sessionId: input.sessionId,
        sessionFile,
        fromOffset,
        toOffset,
        capturedAt: this.#now().getTime(),
        sourceDevice: fileStat.dev,
        sourceInode: fileStat.ino,
      };
      const node: MemoryCheckpointNode = {
        version: 1,
        id: range.id,
        ...(checkpoint.pendingHead
          ? { previousId: checkpoint.pendingHead }
          : {}),
        range,
      };
      await atomicWriteJson(this.#checkpointRangePath(node.id), node);
      await atomicWriteJson(checkpointPath, {
        version: 1,
        chatId: input.chatId,
        cursor: {
          sessionId: input.sessionId,
          sessionFile,
          offset: toOffset,
          sourceDevice: fileStat.dev,
          sourceInode: fileStat.ino,
        },
        pendingHead: node.id,
      } satisfies MemoryCheckpoint);
      return range;
    });
  }

  async promoteCheckpoints(signal?: AbortSignal): Promise<number> {
    if (this.#checkpointPromotionWork) {
      return this.#checkpointPromotionWork;
    }
    const work = this.#promoteCheckpoints(signal).finally(() => {
      if (this.#checkpointPromotionWork === work) {
        this.#checkpointPromotionWork = undefined;
      }
    });
    this.#checkpointPromotionWork = work;
    return work;
  }

  async claimNextJob(
    nowMs = this.#now().getTime(),
    signal?: AbortSignal,
  ): Promise<MemoryExtractionJob | null> {
    await this.promoteCheckpoints(signal);
    const jobs: MemoryExtractionJob[] = [];
    for (const name of await readAbortableJsonFileNames(
      this.#jobsDir,
      signal,
    )) {
      throwIfAborted(signal);
      const job = await readOptionalJson(
        join(this.#jobsDir, name),
        parseMemoryExtractionJob,
      );
      if (job?.status === "pending" && job.nextAttemptAt <= nowMs) {
        jobs.push(job);
      }
    }
    jobs.sort(compareExtractionJobs);
    const job = jobs[0];
    if (!job) {
      return null;
    }
    return this.#serialize(async () => {
      throwIfAborted(signal);
      const current = await readRequiredJson(
        this.#jobPath(job.id),
        parseMemoryExtractionJob,
      );
      if (current.status !== "pending" || current.nextAttemptAt > nowMs) {
        return null;
      }
      const claimed: MemoryExtractionJob = {
        ...current,
        status: "running",
        attempts: current.attempts + 1,
      };
      await atomicWriteJson(this.#jobPath(job.id), claimed);
      return claimed;
    });
  }

  async retryJob(jobId: string, nextAttemptAt: number): Promise<void> {
    await this.#serialize(async () => {
      const path = this.#jobPath(jobId);
      const job = await readRequiredJson(path, parseMemoryExtractionJob);
      requireSafeInteger(nextAttemptAt, "nextAttemptAt", 0);
      await atomicWriteJson(path, {
        ...job,
        status: "pending",
        nextAttemptAt,
      } satisfies MemoryExtractionJob);
    });
  }

  async failJob(jobId: string): Promise<void> {
    await this.#serialize(async () => {
      const path = this.#jobPath(jobId);
      const job = await readRequiredJson(path, parseMemoryExtractionJob);
      await atomicWriteJson(this.#failedJobPath(jobId), {
        ...job,
        status: "failed",
      } satisfies MemoryExtractionJob);
      await rm(path, { force: true });
    });
  }

  async completeExtractionJob(
    job: MemoryExtractionJob,
    entries: readonly ExtractedMemoryEntry[],
  ): Promise<MemoryOperationResult> {
    return this.#serialize(async () => {
      const existing = await this.#readReceipt(job.id);
      if (existing) {
        const result =
          existing.status === "completed"
            ? existing.result
            : await this.#finishPreparedReceipt(existing);
        await rm(this.#jobPath(job.id), { force: true });
        return result;
      }
      const writes = await this.#buildExtractionWrites(job.id, entries);
      const result = await this.#commitReceiptUnlocked(job.id, writes, {
        content: `Stored ${entries.length} extracted memory item(s).`,
      });
      await rm(this.#jobPath(job.id), { force: true });
      return result;
    });
  }

  async executeMutation(
    receiptId: string,
    args: MemoryToolArguments,
  ): Promise<MemoryOperationResult> {
    return this.#serialize(async () => {
      requireNonEmpty(receiptId, "receiptId");
      const existing = await this.#readReceipt(receiptId);
      if (existing) {
        return existing.status === "completed"
          ? existing.result
          : this.#finishPreparedReceipt(existing);
      }
      const plan = await this.#buildToolPlan(receiptId, args);
      return this.#commitReceiptUnlocked(receiptId, plan.writes, plan.result);
    });
  }

  async read(args: MemoryToolArguments): Promise<MemoryOperationResult> {
    return this.#serialize(async () => {
      if (args.toolName === "memory_read") {
        return this.#readMemory(args);
      }
      if (args.toolName === "memory_search") {
        return this.#keywordSearch(args.query, args.limit ?? 10);
      }
      if (args.toolName === "memory_status") {
        const dailyFiles = await readMarkdownFileNames(
          join(this.#memoryDir, "daily"),
        );
        const scratchpad = await readFile(
          join(this.#memoryDir, SCRATCHPAD_FILE),
          "utf8",
        );
        const items = parseScratchpad(scratchpad);
        const [activeJobs, failedJobs] = await Promise.all([
          readJsonFileNames(this.#jobsDir),
          readJsonFileNames(this.#failedJobsDir),
        ]);
        return {
          content: [
            `Memory revision: ${this.#state.memoryRevision}`,
            `Daily logs: ${dailyFiles.length}`,
            `Scratchpad: ${items.filter((item) => !item.done).length} open / ${items.length} total`,
            `Extraction jobs: ${activeJobs.length} active / ${failedJobs.length} failed`,
            `qmd update revision: ${this.#state.qmdUpdatedRevision}`,
            `qmd embed revision: ${this.#state.qmdEmbeddedRevision}`,
          ].join("\n"),
        };
      }
      if (args.toolName === "scratchpad" && args.action === "list") {
        const content = await readFile(
          join(this.#memoryDir, SCRATCHPAD_FILE),
          "utf8",
        );
        return {
          content: content.trim()
            ? boundedContent(content)
            : "Scratchpad is empty.",
        };
      }
      throw new Error(`${args.toolName} is not a read operation`);
    });
  }

  async updateQmdWatermarks(update: {
    updatedRevision?: number;
    embeddedRevision?: number;
  }): Promise<void> {
    await this.#serialize(async () => {
      const updatedRevision = Math.max(
        this.#state.qmdUpdatedRevision,
        update.updatedRevision === undefined
          ? this.#state.qmdUpdatedRevision
          : requireSafeInteger(update.updatedRevision, "updatedRevision", 0),
      );
      const embeddedRevision = Math.max(
        this.#state.qmdEmbeddedRevision,
        update.embeddedRevision === undefined
          ? this.#state.qmdEmbeddedRevision
          : requireSafeInteger(update.embeddedRevision, "embeddedRevision", 0),
      );
      if (
        updatedRevision > this.#state.memoryRevision ||
        embeddedRevision > updatedRevision
      ) {
        throw new Error("Invalid qmd revision watermark");
      }
      this.#state = {
        ...this.#state,
        qmdUpdatedRevision: updatedRevision,
        qmdEmbeddedRevision: embeddedRevision,
      };
      await atomicWriteJson(join(this.#metadataDir, STATE_FILE), this.#state);
    });
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#operationQueue.then(operation, operation);
    this.#operationQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async #serializeCheckpoint<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#checkpointOperationQueue.then(operation, operation);
    this.#checkpointOperationQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async #promoteCheckpoints(signal?: AbortSignal): Promise<number> {
    const candidates = await (async () => {
      const heads: Array<{
        checkpointPath: string;
        chatId: number;
        headId: string;
      }> = [];
      for (const name of (
        await readAbortableJsonFileNames(this.#checkpointsDir, signal)
      ).sort()) {
        throwIfAborted(signal);
        const checkpointPath = join(this.#checkpointsDir, name);
        const checkpoint = await readRequiredJson(
          checkpointPath,
          parseMemoryCheckpoint,
        );
        if (!checkpoint.pendingHead) {
          continue;
        }
        heads.push({
          checkpointPath,
          chatId: checkpoint.chatId,
          headId: checkpoint.pendingHead,
        });
      }
      return heads;
    })();

    let promoted = 0;
    for (const candidate of candidates) {
      const nodes: MemoryCheckpointNode[] = [];
      const visited = new Set<string>();
      let nodeId: string | undefined = candidate.headId;
      while (nodeId) {
        throwIfAborted(signal);
        if (visited.has(nodeId)) {
          throw new Error("Memory checkpoint chain contains a cycle");
        }
        visited.add(nodeId);
        const node: MemoryCheckpointNode = await readRequiredJson(
          this.#checkpointRangePath(nodeId),
          parseMemoryCheckpointNode,
        );
        nodes.push(node);
        nodeId = node.previousId;
      }
      for (const node of nodes.reverse()) {
        const extractionRanges = await splitCheckpointRange(
          candidate.chatId,
          node.range,
          signal,
        );
        for (const extractionRange of extractionRanges) {
          throwIfAborted(signal);
          const jobPath = this.#jobPath(extractionRange.id);
          const existing = await readOptionalJson(
            jobPath,
            parseMemoryExtractionJob,
          );
          if (!existing) {
            await atomicWriteJson(jobPath, {
              version: 1,
              chatId: candidate.chatId,
              ...extractionRange,
              status: "pending",
              attempts: 0,
              nextAttemptAt: 0,
            } satisfies MemoryExtractionJob);
            promoted += 1;
          }
        }
      }
      throwIfAborted(signal);
      const consumed = await this.#serializeCheckpoint(async () => {
        const checkpoint = await readRequiredJson(
          candidate.checkpointPath,
          parseMemoryCheckpoint,
        );
        if (checkpoint.pendingHead !== candidate.headId) {
          return false;
        }
        const { pendingHead: _pendingHead, ...withoutHead } = checkpoint;
        await atomicWriteJson(candidate.checkpointPath, withoutHead);
        return true;
      });
      if (consumed) {
        for (const node of nodes) {
          if (signal?.aborted) {
            break;
          }
          await rm(this.#checkpointRangePath(node.id), { force: true });
        }
      }
    }
    return promoted;
  }

  async #migrateLegacyCheckpoints(): Promise<void> {
    for (const name of await readJsonFileNames(this.#checkpointsDir)) {
      const checkpointPath = join(this.#checkpointsDir, name);
      const checkpoint = await readRequiredJson(
        checkpointPath,
        parseMemoryCheckpoint,
      );
      if (!checkpoint.pending || checkpoint.pending.length === 0) {
        continue;
      }
      let pendingHead = checkpoint.pendingHead;
      for (const range of checkpoint.pending) {
        const node: MemoryCheckpointNode = {
          version: 1,
          id: range.id,
          ...(pendingHead ? { previousId: pendingHead } : {}),
          range,
        };
        await atomicWriteJson(this.#checkpointRangePath(node.id), node);
        pendingHead = node.id;
      }
      await atomicWriteJson(checkpointPath, {
        version: 1,
        chatId: checkpoint.chatId,
        ...(checkpoint.cursor ? { cursor: checkpoint.cursor } : {}),
        ...(pendingHead ? { pendingHead } : {}),
      } satisfies MemoryCheckpoint);
    }
  }

  async #recoverPreparedReceipts(): Promise<void> {
    const prepared: PreparedReceipt[] = [];
    let maximumRevision = this.#state.memoryRevision;
    for (const name of await readJsonFileNames(this.#receiptsDir)) {
      const receipt = await readRequiredJson(
        join(this.#receiptsDir, name),
        parseReceipt,
      );
      maximumRevision = Math.max(maximumRevision, receipt.revision);
      if (receipt.status === "prepared") {
        prepared.push(receipt);
      }
    }
    prepared.sort((left, right) => left.revision - right.revision);
    for (const receipt of prepared) {
      await this.#finishPreparedReceipt(receipt);
    }
    if (maximumRevision > this.#state.memoryRevision) {
      this.#state = { ...this.#state, memoryRevision: maximumRevision };
      await atomicWriteJson(join(this.#metadataDir, STATE_FILE), this.#state);
    }
  }

  async #recoverRunningJobs(): Promise<void> {
    const names = await readJsonFileNames(this.#jobsDir);
    for (const name of names) {
      const path = join(this.#jobsDir, name);
      const job = await readRequiredJson(path, parseMemoryExtractionJob);
      if (job.status === "failed") {
        await atomicWriteJson(this.#failedJobPath(job.id), job);
        await rm(path, { force: true });
        continue;
      }
      if (
        await readOptionalJson(
          this.#failedJobPath(job.id),
          parseMemoryExtractionJob,
        )
      ) {
        await rm(path, { force: true });
        continue;
      }
      if (job.status === "running") {
        await atomicWriteJson(path, { ...job, status: "pending" });
      }
    }
  }

  async #buildToolPlan(
    receiptId: string,
    args: MemoryToolArguments,
  ): Promise<{
    writes: Array<{ relativePath: string; content: string }>;
    result: MemoryOperationResult;
  }> {
    const marker = mutationMarker(receiptId);
    const timestamp = formatTimestamp(this.#now());
    if (args.toolName === "memory_write") {
      const relativePath =
        args.target === "long_term"
          ? MEMORY_FILE
          : dailyRelativePath(today(this.#now()));
      const existing = await readMemoryFile(this.#memoryDir, relativePath);
      if (existing.includes(marker)) {
        return {
          writes: [],
          result: { content: "Memory was already stored." },
        };
      }
      const entry = `${timestampComment(timestamp, args.mode === "overwrite")}\n${marker}\n${args.content}`;
      const content =
        args.target === "long_term" && args.mode === "overwrite"
          ? `${entry}\n`
          : appendBlock(existing, entry);
      return {
        writes: [{ relativePath, content }],
        result: {
          content:
            args.target === "daily"
              ? "Appended to daily log."
              : args.mode === "overwrite"
                ? "Overwrote MEMORY.md."
                : "Appended to MEMORY.md.",
        },
      };
    }

    if (args.toolName === "scratchpad") {
      const relativePath = SCRATCHPAD_FILE;
      const existing = await readMemoryFile(this.#memoryDir, relativePath);
      if (existing.includes(marker)) {
        return {
          writes: [],
          result: { content: "Scratchpad was already updated." },
        };
      }
      if (args.action === "list") {
        throw new Error("scratchpad list is not a mutation");
      }
      if (args.action === "add") {
        if (!args.text) {
          return {
            writes: [],
            result: {
              content: "Error: 'text' is required for add.",
              isError: true,
            },
          };
        }
        const base = existing.trim()
          ? existing.replace(/\n+$/, "")
          : "# Scratchpad";
        return {
          writes: [
            {
              relativePath,
              content: `${base}\n${timestampComment(timestamp)}\n- [ ] ${args.text}\n${marker}\n`,
            },
          ],
          result: { content: `Added: - [ ] ${args.text}` },
        };
      }
      if (args.action === "done" || args.action === "undo") {
        if (!args.text) {
          return {
            writes: [],
            result: {
              content: `Error: 'text' is required for ${args.action}.`,
              isError: true,
            },
          };
        }
        const toggled = toggleScratchpad(
          existing,
          args.text,
          args.action === "done",
        );
        if (!toggled.matched) {
          return {
            writes: [],
            result: {
              content: `No matching item found for: "${args.text}"`,
              isError: true,
            },
          };
        }
        return {
          writes: [
            { relativePath, content: appendMarker(toggled.content, marker) },
          ],
          result: { content: "Updated." },
        };
      }
      const cleared = clearDoneScratchpad(existing);
      return {
        writes: [
          { relativePath, content: appendMarker(cleared.content, marker) },
        ],
        result: { content: `Cleared ${cleared.removed} done item(s).` },
      };
    }

    if (args.toolName === "memory_forget") {
      const target = args.target ?? "long_term";
      const date =
        target === "daily" ? (args.date ?? today(this.#now())) : undefined;
      if (date && !isValidDate(date)) {
        return {
          writes: [],
          result: { content: "Invalid daily date.", isError: true },
        };
      }
      const relativePath =
        target === "long_term"
          ? MEMORY_FILE
          : dailyRelativePath(date ?? today(this.#now()));
      const existing = await readMemoryFile(this.#memoryDir, relativePath);
      const forgotten = forgetBlocks(existing, args.match);
      if (forgotten.removed.length === 0) {
        return {
          writes: [],
          result: {
            content: "No matching memory entries found.",
            isError: true,
          },
        };
      }
      const recoveryId = this.#createId();
      if (!RECOVERY_ID_PATTERN.test(recoveryId)) {
        throw new Error("createId returned an invalid recovery ID");
      }
      const record: MemoryRecoveryRecord = {
        version: 1,
        id: recoveryId,
        createdAt: this.#now().toISOString(),
        target,
        ...(date ? { date } : {}),
        removedContent: forgotten.removed,
      };
      return {
        writes: [
          { relativePath, content: forgotten.content },
          {
            relativePath: `recovery/${recoveryId}.json`,
            content: `${JSON.stringify(record, null, 2)}\n`,
          },
        ],
        result: {
          content: `Removed ${forgotten.removed.length} memory entr${forgotten.removed.length === 1 ? "y" : "ies"}. Recovery ID: ${recoveryId}`,
        },
      };
    }

    if (args.toolName === "memory_restore") {
      if (!RECOVERY_ID_PATTERN.test(args.recoveryId)) {
        return {
          writes: [],
          result: { content: "Invalid recovery ID.", isError: true },
        };
      }
      const recoveryPath = `recovery/${args.recoveryId}.json`;
      const recordText = await readMemoryFile(this.#memoryDir, recoveryPath);
      if (!recordText) {
        return {
          writes: [],
          result: { content: "Recovery record not found.", isError: true },
        };
      }
      const record = parseMemoryRecoveryRecord(
        JSON.parse(recordText) as unknown,
      );
      if (record.id !== args.recoveryId) {
        throw new Error("Recovery record ID mismatch");
      }
      if (record.restoredAt) {
        return {
          writes: [],
          result: { content: "Memory was already restored." },
        };
      }
      const relativePath =
        record.target === "long_term"
          ? MEMORY_FILE
          : dailyRelativePath(record.date ?? today(this.#now()));
      const existing = await readMemoryFile(this.#memoryDir, relativePath);
      const restored = record.removedContent.reduce(appendBlock, existing);
      const updated: MemoryRecoveryRecord = {
        ...record,
        restoredAt: this.#now().toISOString(),
      };
      return {
        writes: [
          { relativePath, content: appendMarker(restored, marker) },
          {
            relativePath: recoveryPath,
            content: `${JSON.stringify(updated, null, 2)}\n`,
          },
        ],
        result: {
          content: `Restored ${record.removedContent.length} memory entr${record.removedContent.length === 1 ? "y" : "ies"}.`,
        },
      };
    }

    throw new Error(`${args.toolName} is not a mutation operation`);
  }

  async #buildExtractionWrites(
    mutationId: string,
    entries: readonly ExtractedMemoryEntry[],
  ): Promise<Array<{ relativePath: string; content: string }>> {
    const byPath = new Map<string, string>();
    const timestamp = formatTimestamp(this.#now());
    for (const [index, entry] of entries.entries()) {
      if (
        !entry.content.trim() ||
        entry.content.length > MEMORY_CONTENT_MAX_CHARS
      ) {
        throw new Error("Extracted memory content is invalid");
      }
      const date =
        entry.target === "daily"
          ? (entry.date ?? today(this.#now()))
          : undefined;
      if (date && !isValidDate(date)) {
        throw new Error("Extracted daily date is invalid");
      }
      const relativePath =
        entry.target === "long_term"
          ? MEMORY_FILE
          : dailyRelativePath(date ?? today(this.#now()));
      const current =
        byPath.get(relativePath) ??
        (await readMemoryFile(this.#memoryDir, relativePath));
      const marker = mutationMarker(`${mutationId}:${index}`);
      if (!current.includes(marker)) {
        byPath.set(
          relativePath,
          appendBlock(
            current,
            `${timestampComment(timestamp)}\n${marker}\n${entry.content}`,
          ),
        );
      }
    }
    return [...byPath].map(([relativePath, content]) => ({
      relativePath,
      content,
    }));
  }

  async #commitReceiptUnlocked(
    receiptId: string,
    writes: Array<{ relativePath: string; content: string }>,
    result: MemoryOperationResult,
  ): Promise<MemoryOperationResult> {
    const prepared: PreparedReceipt = {
      version: RECEIPT_VERSION,
      status: "prepared",
      receiptId,
      revision: this.#state.memoryRevision + (writes.length > 0 ? 1 : 0),
      writes,
      result,
    };
    await atomicWriteJson(this.#receiptPath(receiptId), prepared);
    return this.#finishPreparedReceipt(prepared);
  }

  async #finishPreparedReceipt(
    receipt: PreparedReceipt,
  ): Promise<MemoryOperationResult> {
    if (receipt.writes.length > 0) {
      this.#contentGeneration += 1;
    }
    for (const write of receipt.writes) {
      const path = resolveWithin(this.#memoryDir, write.relativePath);
      await assertSafeManagedParent(this.#memoryDir, path);
      await atomicWriteFile(path, write.content);
    }
    if (receipt.revision > this.#state.memoryRevision) {
      this.#state = { ...this.#state, memoryRevision: receipt.revision };
      await atomicWriteJson(join(this.#metadataDir, STATE_FILE), this.#state);
    }
    const completed: CompletedReceipt = {
      version: RECEIPT_VERSION,
      status: "completed",
      receiptId: receipt.receiptId,
      revision: receipt.revision,
      result: receipt.result,
    };
    await atomicWriteJson(this.#receiptPath(receipt.receiptId), completed);
    if (receipt.writes.length > 0) {
      this.#scheduleSnapshotRefresh();
    }
    return receipt.result;
  }

  #scheduleSnapshotRefresh(): void {
    if (!this.#snapshotRefreshEnabled) {
      return;
    }
    this.#snapshotDirty = true;
    if (this.#snapshotWork) {
      return;
    }
    const controller = new AbortController();
    this.#snapshotController = controller;
    const work = Promise.resolve()
      .then(async () => {
        while (this.#snapshotRefreshEnabled && this.#snapshotDirty) {
          this.#snapshotDirty = false;
          await this.#refreshSnapshot(controller.signal);
        }
      })
      .finally(() => {
        if (this.#snapshotWork === work) {
          this.#snapshotWork = undefined;
          this.#snapshotController = undefined;
        }
        if (this.#snapshotRefreshEnabled && this.#snapshotDirty) {
          this.#scheduleSnapshotRefresh();
        }
      });
    this.#snapshotWork = work;
    void work.catch(() => undefined);
  }

  async #readReceipt(receiptId: string): Promise<Receipt | null> {
    return readOptionalJson(this.#receiptPath(receiptId), parseReceipt);
  }

  async #readMemory(
    args: Extract<MemoryToolArguments, { toolName: "memory_read" }>,
  ): Promise<MemoryOperationResult> {
    if (args.target === "list") {
      const files = (
        await readMarkdownFileNames(join(this.#memoryDir, "daily"))
      )
        .sort()
        .reverse();
      return {
        content:
          files.length === 0
            ? "No daily logs found."
            : `Daily logs:\n${files.map((file) => `- ${file}`).join("\n")}`,
      };
    }
    const relativePath =
      args.target === "long_term"
        ? MEMORY_FILE
        : args.target === "scratchpad"
          ? SCRATCHPAD_FILE
          : dailyRelativePath(args.date ?? today(this.#now()));
    if (args.target === "daily" && args.date && !isValidDate(args.date)) {
      return { content: "Invalid daily date.", isError: true };
    }
    const content = await readMemoryFile(this.#memoryDir, relativePath);
    return {
      content: content.trim()
        ? boundedContent(content)
        : `${relativePath} is empty.`,
    };
  }

  async #keywordSearch(
    query: string,
    limit: number,
  ): Promise<MemoryOperationResult> {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return { content: "Search query is empty.", isError: true };
    }
    const files = [
      MEMORY_FILE,
      SCRATCHPAD_FILE,
      ...(await readMarkdownFileNames(join(this.#memoryDir, "daily"))).map(
        (name) => `daily/${name}`,
      ),
    ];
    const matches: string[] = [];
    for (const relativePath of files) {
      const content = await readMemoryFile(this.#memoryDir, relativePath);
      for (const [index, line] of content.split(/\r?\n/).entries()) {
        if (line.toLowerCase().includes(needle)) {
          matches.push(`${relativePath}:${index + 1}: ${line}`);
          if (matches.length >= limit) {
            return { content: boundedContent(matches.join("\n")) };
          }
        }
      }
    }
    return {
      content:
        matches.length > 0
          ? boundedContent(matches.join("\n"))
          : "No matching memory found.",
    };
  }

  async #refreshSnapshot(signal?: AbortSignal): Promise<void> {
    const generation = this.#contentGeneration;
    const revision = this.#state.memoryRevision;
    const date = today(this.#now());
    const sections = await Promise.all([
      snapshotSection(this.#memoryDir, MEMORY_FILE, signal),
      snapshotSection(this.#memoryDir, SCRATCHPAD_FILE, signal),
      snapshotSection(this.#memoryDir, dailyRelativePath(date), signal),
    ]);
    if (
      generation !== this.#contentGeneration ||
      revision !== this.#state.memoryRevision
    ) {
      return;
    }
    const content = sections.filter(Boolean).join("\n\n");
    this.#snapshot = {
      revision,
      content: content.slice(0, MEMORY_SNAPSHOT_MAX_CHARS),
    };
  }

  #checkpointPath(chatId: number): string {
    return join(this.#checkpointsDir, `${hashKey(String(chatId))}.json`);
  }

  #jobPath(jobId: string): string {
    return join(this.#jobsDir, `${hashKey(jobId)}.json`);
  }

  #failedJobPath(jobId: string): string {
    return join(this.#failedJobsDir, `${hashKey(jobId)}.json`);
  }

  #checkpointRangePath(rangeId: string): string {
    return join(this.#checkpointRangesDir, `${hashKey(rangeId)}.json`);
  }

  #receiptPath(receiptId: string): string {
    return join(this.#receiptsDir, `${hashKey(receiptId)}.json`);
  }
}

function compareExtractionJobs(
  left: MemoryExtractionJob,
  right: MemoryExtractionJob,
): number {
  if (left.chatId === right.chatId && left.sessionId === right.sessionId) {
    return left.fromOffset - right.fromOffset || left.toOffset - right.toOffset;
  }
  return (
    (left.capturedAt ?? 0) - (right.capturedAt ?? 0) ||
    left.chatId - right.chatId ||
    left.sessionId.localeCompare(right.sessionId)
  );
}

export function extractionJobId(
  chatId: number,
  sessionId: string,
  sourceDevice: number,
  sourceInode: number,
  fromOffset: number,
  toOffset: number,
): string {
  return `extract:${chatId}:${sessionId}:${sourceDevice}:${sourceInode}:${fromOffset}:${toOffset}`;
}

function mutationMarker(mutationId: string): string {
  return `<!-- amadeus-memory:${mutationId} -->`;
}

function timestampComment(timestamp: string, overwrite = false): string {
  return `<!-- ${overwrite ? "last updated: " : ""}${timestamp} [amadeus] -->`;
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function today(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dailyRelativePath(date: string): string {
  if (!isValidDate(date)) {
    throw new Error("Invalid daily date");
  }
  return `daily/${date}.md`;
}

function isValidDate(value: string): boolean {
  if (!DAILY_DATE_PATTERN.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function appendBlock(existing: string, block: string): string {
  const base = existing.trimEnd();
  return base ? `${base}\n\n${block.trim()}\n` : `${block.trim()}\n`;
}

function appendMarker(content: string, marker: string): string {
  const base = content.trimEnd();
  return `${base}${base ? "\n" : ""}${marker}\n`;
}

function boundedContent(content: string): string {
  return content.length <= MEMORY_CONTENT_MAX_CHARS
    ? content
    : `${content.slice(0, MEMORY_CONTENT_MAX_CHARS - 18)}\n[output truncated]`;
}

function parseScratchpad(
  content: string,
): Array<{ done: boolean; text: string }> {
  return content
    .split(/\r?\n/)
    .map((line) => line.match(SCRATCHPAD_ITEM_PATTERN))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({
      done: match[1]?.toLowerCase() === "x",
      text: match[2] ?? "",
    }));
}

function toggleScratchpad(
  content: string,
  needle: string,
  done: boolean,
): { content: string; matched: boolean } {
  const lines = content.split("\n");
  const normalized = needle.toLowerCase();
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(SCRATCHPAD_ITEM_PATTERN);
    if (!match || (match[1]?.toLowerCase() === "x") === done) {
      continue;
    }
    if (!(match[2] ?? "").toLowerCase().includes(normalized)) {
      continue;
    }
    lines[index] = `- [${done ? "x" : " "}] ${match[2] ?? ""}`;
    return { content: lines.join("\n"), matched: true };
  }
  return { content, matched: false };
}

function clearDoneScratchpad(content: string): {
  content: string;
  removed: number;
} {
  const lines = content.split("\n");
  const output: string[] = [];
  let removed = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = line.match(SCRATCHPAD_ITEM_PATTERN);
    if (match?.[1]?.toLowerCase() === "x") {
      removed += 1;
      if (output.at(-1)?.match(/^<!-- .* \[[^\]]+\] -->$/)) {
        output.pop();
      }
      if (lines[index + 1]?.startsWith("<!-- amadeus-memory:")) {
        index += 1;
      }
      continue;
    }
    output.push(line);
  }
  return { content: output.join("\n"), removed };
}

function forgetBlocks(
  content: string,
  match: string,
): { content: string; removed: string[] } {
  const needle = match.trim().toLowerCase();
  if (!needle) {
    return { content, removed: [] };
  }
  const blocks: string[] = [];
  let current: string[] = [];
  let stamped = false;
  const flush = (): void => {
    const value = current.join("\n").trim();
    if (!value) {
      return;
    }
    if (stamped) {
      blocks.push(value);
      return;
    }
    blocks.push(
      ...value
        .split(/\n{2,}/)
        .map((block) => block.trim())
        .filter(Boolean),
    );
  };
  for (const line of content.replace(/\r\n?/g, "\n").split("\n")) {
    if (GENERATED_ENTRY_PATTERN.test(line)) {
      flush();
      current = [line];
      stamped = true;
    } else {
      current.push(line);
    }
  }
  flush();
  const removed = blocks.filter((block) =>
    block.toLowerCase().includes(needle),
  );
  if (removed.length === 0) {
    return { content, removed: [] };
  }
  const kept = blocks.filter((block) => !block.toLowerCase().includes(needle));
  return { content: kept.length > 0 ? `${kept.join("\n\n")}\n` : "", removed };
}

async function hasExistingMemoryContent(root: string): Promise<boolean> {
  const [longTerm, scratchpad, dailyFiles] = await Promise.all([
    readMemoryFile(root, MEMORY_FILE),
    readMemoryFile(root, SCRATCHPAD_FILE),
    readMarkdownFileNames(join(root, "daily")),
  ]);
  return (
    longTerm.trim().length > 0 ||
    (scratchpad.trim().length > 0 && scratchpad.trim() !== "# Scratchpad") ||
    dailyFiles.length > 0
  );
}

async function snapshotSection(
  root: string,
  relativePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const content = await readMemoryFile(root, relativePath, signal);
  const trimmed = content.trim();
  if (
    !trimmed ||
    (relativePath === SCRATCHPAD_FILE && trimmed === "# Scratchpad")
  ) {
    return "";
  }
  return `### ${relativePath}\n${trimmed}`;
}

async function readMemoryFile(
  root: string,
  relativePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const path = resolveWithin(root, relativePath);
  try {
    await assertSafeManagedParent(root, path);
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error("Managed memory files must not be symbolic links");
    }
    return await readFile(path, { encoding: "utf8", signal });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return "";
    }
    throw error;
  }
}

async function assertCanonicalDirectory(
  root: string,
  relativePath: string,
): Promise<void> {
  const expected = resolve(root, relativePath);
  if ((await realpath(expected)) !== expected) {
    throw new Error("Managed memory directories must not be symbolic links");
  }
}

async function assertSafeManagedParent(
  root: string,
  path: string,
): Promise<void> {
  const parent = await realpath(dirname(path));
  if (!isPathWithin(root, parent)) {
    throw new Error("Memory write parent escapes the configured directory");
  }
}

function isPathWithin(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function resolveWithin(root: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new Error("Memory path must be relative");
  }
  const path = resolve(root, relativePath);
  if (!isPathWithin(root, path)) {
    throw new Error("Memory path escapes the configured directory");
  }
  return path;
}

async function assertSessionHeader(
  path: string,
  expectedSessionId: string,
  fileSize: number,
): Promise<void> {
  if (fileSize === 0) {
    throw new Error("Session file is empty");
  }
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(
      Math.min(fileSize, SESSION_HEADER_MAX_BYTES + 1),
    );
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const lineEnd = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (lineEnd < 0 || lineEnd > SESSION_HEADER_MAX_BYTES) {
      throw new Error("Session header is missing or too large");
    }
    if (lineEnd > 0 && buffer[lineEnd - 1] === 0x0d) {
      throw new Error("Session header must use LF JSONL");
    }
    const header = requireRecord(
      JSON.parse(buffer.subarray(0, lineEnd).toString("utf8")) as unknown,
      "Session header",
    );
    if (header.type !== "session" || header.id !== expectedSessionId) {
      throw new Error("Session header does not match the checkpoint session");
    }
  } finally {
    await handle.close();
  }
}

async function splitCheckpointRange(
  chatId: number,
  range: MemoryCheckpointRange,
  signal?: AbortSignal,
): Promise<MemoryCheckpointRange[]> {
  if (range.sourceDevice === undefined || range.sourceInode === undefined) {
    return [range];
  }
  try {
    const [sessionFile, sourceStat] = await Promise.all([
      realpath(range.sessionFile),
      stat(range.sessionFile),
    ]);
    if (
      sessionFile !== range.sessionFile ||
      sourceStat.dev !== range.sourceDevice ||
      sourceStat.ino !== range.sourceInode ||
      sourceStat.size < range.toOffset
    ) {
      return [range];
    }
    const offsets = await splitJsonlRanges(
      sessionFile,
      range.fromOffset,
      range.toOffset,
      CHECKPOINT_RANGE_TARGET_BYTES,
      signal,
    );
    return offsets.map(({ fromOffset, toOffset }) => ({
      ...range,
      id: extractionJobId(
        chatId,
        range.sessionId,
        range.sourceDevice ?? 0,
        range.sourceInode ?? 0,
        fromOffset,
        toOffset,
      ),
      fromOffset,
      toOffset,
    }));
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    return [range];
  }
}

async function splitJsonlRanges(
  path: string,
  fromOffset: number,
  toOffset: number,
  targetBytes: number,
  signal?: AbortSignal,
): Promise<Array<{ fromOffset: number; toOffset: number }>> {
  const ranges: Array<{ fromOffset: number; toOffset: number }> = [];
  const handle = await open(path, "r");
  const buffer = Buffer.alloc(64 * 1024);
  let rangeStart = fromOffset;
  let previousBoundary = fromOffset;
  let position = fromOffset;
  try {
    while (position < toOffset) {
      throwIfAborted(signal);
      const length = Math.min(buffer.length, toOffset - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) {
        throw new Error("Session file ended before the checkpoint boundary");
      }
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] !== 0x0a) {
          continue;
        }
        const boundary = position + index + 1;
        if (boundary - rangeStart > targetBytes) {
          if (previousBoundary > rangeStart) {
            ranges.push({
              fromOffset: rangeStart,
              toOffset: previousBoundary,
            });
            rangeStart = previousBoundary;
          }
          if (boundary - rangeStart > targetBytes) {
            ranges.push({ fromOffset: rangeStart, toOffset: boundary });
            rangeStart = boundary;
          }
        }
        previousBoundary = boundary;
      }
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  if (previousBoundary !== toOffset) {
    throw new Error("Session checkpoint does not end at an LF boundary");
  }
  if (rangeStart < toOffset) {
    ranges.push({ fromOffset: rangeStart, toOffset });
  }
  return ranges;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  const error = new Error("Memory checkpoint promotion was aborted");
  error.name = "AbortError";
  throw error;
}

async function assertJsonlBoundary(
  path: string,
  fromOffset: number,
  toOffset: number,
): Promise<void> {
  if (fromOffset === toOffset) {
    return;
  }
  const handle = await open(path, "r");
  try {
    if (fromOffset > 0) {
      const before = Buffer.alloc(1);
      const read = await handle.read(before, 0, 1, fromOffset - 1);
      if (read.bytesRead !== 1 || before[0] !== 0x0a) {
        throw new Error("Session checkpoint does not start at an LF boundary");
      }
    }
    const ending = Buffer.alloc(Math.min(2, toOffset));
    const read = await handle.read(
      ending,
      0,
      ending.length,
      toOffset - ending.length,
    );
    if (
      read.bytesRead !== ending.length ||
      ending[ending.length - 1] !== 0x0a ||
      (ending.length === 2 && ending[0] === 0x0d)
    ) {
      throw new Error(
        "Session checkpoint does not end at a strict LF boundary",
      );
    }
  } finally {
    await handle.close();
  }
}

async function ensureFile(path: string, content: string): Promise<void> {
  try {
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(dirname(path));
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) {
      throw error;
    }
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicWriteFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readOptionalJson<T>(
  path: string,
  parse: (value: unknown) => T,
): Promise<T | null> {
  try {
    return parse(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

async function readRequiredJson<T>(
  path: string,
  parse: (value: unknown) => T,
): Promise<T> {
  const value = await readOptionalJson(path, parse);
  if (!value) {
    throw new Error(`Required memory metadata is missing: ${path}`);
  }
  return value;
}

async function readJsonFileNames(path: string): Promise<string[]> {
  return readFileNames(path, ".json");
}

async function readAbortableJsonFileNames(
  path: string,
  signal?: AbortSignal,
): Promise<string[]> {
  throwIfAborted(signal);
  const names: string[] = [];
  let directory: Awaited<ReturnType<typeof opendir>>;
  try {
    directory = await opendir(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return names;
    }
    throw error;
  }
  for await (const entry of directory) {
    throwIfAborted(signal);
    if (entry.isFile() && entry.name.endsWith(".json")) {
      names.push(entry.name);
    }
  }
  return names;
}

async function readMarkdownFileNames(path: string): Promise<string[]> {
  return readFileNames(path, ".md");
}

async function readFileNames(path: string, suffix: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => entry.name);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${path} contains unknown fields: ${unknown.join(", ")}`);
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string`);
  }
  return value;
}

function requireNonEmpty(value: unknown, path: string): string {
  const text = requireString(value, path);
  if (!text.trim()) {
    throw new Error(`${path} must not be empty`);
  }
  return text;
}

function requireSafeInteger(
  value: unknown,
  path: string,
  minimum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new Error(
      `${path} must be a safe integer greater than or equal to ${minimum}`,
    );
  }
  return value;
}

function parseMemoryState(value: unknown): MemoryState {
  const record = requireRecord(value, "Memory state");
  assertOnlyKeys(
    record,
    ["version", "memoryRevision", "qmdUpdatedRevision", "qmdEmbeddedRevision"],
    "Memory state",
  );
  if (record.version !== 1) {
    throw new Error("Unsupported memory state version");
  }
  const state: MemoryState = {
    version: 1,
    memoryRevision: requireSafeInteger(
      record.memoryRevision,
      "memoryRevision",
      0,
    ),
    qmdUpdatedRevision: requireSafeInteger(
      record.qmdUpdatedRevision,
      "qmdUpdatedRevision",
      0,
    ),
    qmdEmbeddedRevision: requireSafeInteger(
      record.qmdEmbeddedRevision,
      "qmdEmbeddedRevision",
      0,
    ),
  };
  if (
    state.qmdUpdatedRevision > state.memoryRevision ||
    state.qmdEmbeddedRevision > state.qmdUpdatedRevision
  ) {
    throw new Error("Invalid memory state revision watermarks");
  }
  return state;
}

function parseMemoryCheckpoint(value: unknown): MemoryCheckpoint {
  const record = requireRecord(value, "Memory checkpoint");
  assertOnlyKeys(
    record,
    ["version", "chatId", "cursor", "pendingHead", "pending"],
    "Memory checkpoint",
  );
  if (
    record.version !== 1 ||
    (record.pending !== undefined && !Array.isArray(record.pending))
  ) {
    throw new Error("Invalid memory checkpoint");
  }
  const cursor =
    record.cursor === undefined
      ? undefined
      : parseCheckpointCursor(record.cursor);
  return {
    version: 1,
    chatId: requireSafeInteger(record.chatId, "chatId", 1),
    ...(cursor ? { cursor } : {}),
    ...(record.pendingHead === undefined
      ? {}
      : { pendingHead: requireNonEmpty(record.pendingHead, "pendingHead") }),
    ...(record.pending === undefined
      ? {}
      : { pending: record.pending.map(parseCheckpointRange) }),
  };
}

function parseMemoryCheckpointNode(value: unknown): MemoryCheckpointNode {
  const record = requireRecord(value, "Memory checkpoint node");
  assertOnlyKeys(
    record,
    ["version", "id", "previousId", "range"],
    "Memory checkpoint node",
  );
  if (record.version !== 1) {
    throw new Error("Invalid memory checkpoint node");
  }
  const id = requireNonEmpty(record.id, "id");
  const range = parseCheckpointRange(record.range);
  if (range.id !== id) {
    throw new Error("Memory checkpoint node ID mismatch");
  }
  return {
    version: 1,
    id,
    ...(record.previousId === undefined
      ? {}
      : { previousId: requireNonEmpty(record.previousId, "previousId") }),
    range,
  };
}

function parseCheckpointCursor(value: unknown): MemoryCheckpoint["cursor"] {
  const record = requireRecord(value, "Memory checkpoint cursor");
  assertOnlyKeys(
    record,
    ["sessionId", "sessionFile", "offset", "sourceDevice", "sourceInode"],
    "Memory checkpoint cursor",
  );
  return {
    sessionId: requireNonEmpty(record.sessionId, "sessionId"),
    sessionFile: requireNonEmpty(record.sessionFile, "sessionFile"),
    offset: requireSafeInteger(record.offset, "offset", 0),
    ...(record.sourceDevice === undefined
      ? {}
      : {
          sourceDevice: requireSafeInteger(
            record.sourceDevice,
            "sourceDevice",
            0,
          ),
        }),
    ...(record.sourceInode === undefined
      ? {}
      : {
          sourceInode: requireSafeInteger(record.sourceInode, "sourceInode", 0),
        }),
  };
}

function parseCheckpointRange(value: unknown): MemoryCheckpointRange {
  const record = requireRecord(value, "Memory checkpoint range");
  assertOnlyKeys(
    record,
    [
      "id",
      "sessionId",
      "sessionFile",
      "fromOffset",
      "toOffset",
      "capturedAt",
      "sourceDevice",
      "sourceInode",
    ],
    "Memory checkpoint range",
  );
  const fromOffset = requireSafeInteger(record.fromOffset, "fromOffset", 0);
  const toOffset = requireSafeInteger(record.toOffset, "toOffset", 0);
  if (toOffset <= fromOffset) {
    throw new Error("Memory checkpoint range must not be empty");
  }
  return {
    id: requireNonEmpty(record.id, "id"),
    sessionId: requireNonEmpty(record.sessionId, "sessionId"),
    sessionFile: requireNonEmpty(record.sessionFile, "sessionFile"),
    fromOffset,
    toOffset,
    ...(record.capturedAt === undefined
      ? {}
      : {
          capturedAt: requireSafeInteger(record.capturedAt, "capturedAt", 0),
        }),
    ...(record.sourceDevice === undefined
      ? {}
      : {
          sourceDevice: requireSafeInteger(
            record.sourceDevice,
            "sourceDevice",
            0,
          ),
        }),
    ...(record.sourceInode === undefined
      ? {}
      : {
          sourceInode: requireSafeInteger(record.sourceInode, "sourceInode", 0),
        }),
  };
}

function parseMemoryExtractionJob(value: unknown): MemoryExtractionJob {
  const record = requireRecord(value, "Memory extraction job");
  assertOnlyKeys(
    record,
    [
      "version",
      "chatId",
      "id",
      "sessionId",
      "sessionFile",
      "fromOffset",
      "toOffset",
      "capturedAt",
      "sourceDevice",
      "sourceInode",
      "status",
      "attempts",
      "nextAttemptAt",
    ],
    "Memory extraction job",
  );
  if (
    record.version !== 1 ||
    (record.status !== "pending" &&
      record.status !== "running" &&
      record.status !== "failed")
  ) {
    throw new Error("Invalid memory extraction job");
  }
  const fromOffset = requireSafeInteger(record.fromOffset, "fromOffset", 0);
  const toOffset = requireSafeInteger(record.toOffset, "toOffset", 0);
  if (toOffset <= fromOffset) {
    throw new Error("Memory extraction job range must not be empty");
  }
  return {
    version: 1,
    chatId: requireSafeInteger(record.chatId, "chatId", 1),
    id: requireNonEmpty(record.id, "id"),
    sessionId: requireNonEmpty(record.sessionId, "sessionId"),
    sessionFile: requireNonEmpty(record.sessionFile, "sessionFile"),
    fromOffset,
    toOffset,
    ...(record.capturedAt === undefined
      ? {}
      : {
          capturedAt: requireSafeInteger(record.capturedAt, "capturedAt", 0),
        }),
    ...(record.sourceDevice === undefined
      ? {}
      : {
          sourceDevice: requireSafeInteger(
            record.sourceDevice,
            "sourceDevice",
            0,
          ),
        }),
    ...(record.sourceInode === undefined
      ? {}
      : {
          sourceInode: requireSafeInteger(record.sourceInode, "sourceInode", 0),
        }),
    status: record.status,
    attempts: requireSafeInteger(record.attempts, "attempts", 0),
    nextAttemptAt: requireSafeInteger(record.nextAttemptAt, "nextAttemptAt", 0),
  };
}

function parseReceipt(value: unknown): Receipt {
  const record = requireRecord(value, "Memory receipt");
  if (
    record.version !== 1 ||
    (record.status !== "prepared" && record.status !== "completed")
  ) {
    throw new Error("Invalid memory receipt");
  }
  if (record.status === "completed") {
    assertOnlyKeys(
      record,
      ["version", "status", "receiptId", "revision", "result"],
      "Memory receipt",
    );
    return {
      version: 1,
      status: "completed",
      receiptId: requireNonEmpty(record.receiptId, "receiptId"),
      revision: requireSafeInteger(record.revision, "revision", 0),
      result: parseOperationResult(record.result),
    };
  }
  assertOnlyKeys(
    record,
    ["version", "status", "receiptId", "revision", "writes", "result"],
    "Memory receipt",
  );
  if (!Array.isArray(record.writes)) {
    throw new Error("Prepared memory receipt writes must be an array");
  }
  return {
    version: 1,
    status: "prepared",
    receiptId: requireNonEmpty(record.receiptId, "receiptId"),
    revision: requireSafeInteger(record.revision, "revision", 0),
    writes: record.writes.map((value) => {
      const write = requireRecord(value, "Memory receipt write");
      assertOnlyKeys(
        write,
        ["relativePath", "content"],
        "Memory receipt write",
      );
      return {
        relativePath: requireNonEmpty(write.relativePath, "relativePath"),
        content: requireString(write.content, "content"),
      };
    }),
    result: parseOperationResult(record.result),
  };
}

function parseOperationResult(value: unknown): MemoryOperationResult {
  const record = requireRecord(value, "Memory operation result");
  assertOnlyKeys(record, ["content", "isError"], "Memory operation result");
  if (record.isError !== undefined && record.isError !== true) {
    throw new Error("Memory operation isError must be true when present");
  }
  return {
    content: requireString(record.content, "content"),
    ...(record.isError === true ? { isError: true } : {}),
  };
}

function parseMemoryRecoveryRecord(value: unknown): MemoryRecoveryRecord {
  const record = requireRecord(value, "Memory recovery record");
  assertOnlyKeys(
    record,
    [
      "version",
      "id",
      "createdAt",
      "target",
      "date",
      "removedContent",
      "restoredAt",
    ],
    "Memory recovery record",
  );
  if (
    record.version !== 1 ||
    !RECOVERY_ID_PATTERN.test(requireString(record.id, "id")) ||
    (record.target !== "long_term" && record.target !== "daily") ||
    !Array.isArray(record.removedContent) ||
    record.removedContent.length === 0
  ) {
    throw new Error("Invalid memory recovery record");
  }
  const date =
    record.date === undefined ? undefined : requireString(record.date, "date");
  if (
    (record.target === "daily" && (!date || !isValidDate(date))) ||
    (record.target === "long_term" && date)
  ) {
    throw new Error("Invalid memory recovery date");
  }
  return {
    version: 1,
    id: requireString(record.id, "id"),
    createdAt: requireNonEmpty(record.createdAt, "createdAt"),
    target: record.target,
    ...(date ? { date } : {}),
    removedContent: record.removedContent.map((item) =>
      requireString(item, "removedContent"),
    ),
    ...(record.restoredAt === undefined
      ? {}
      : { restoredAt: requireNonEmpty(record.restoredAt, "restoredAt") }),
  };
}
