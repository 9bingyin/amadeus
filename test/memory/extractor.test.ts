import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMemoryWorkerArgs,
  MemoryExtractor,
} from "../../src/memory/extractor";
import type {
  PiRpcClientLike,
  PiRpcEventListener,
  PiRpcFatalListener,
  PiRpcRequestHandle,
} from "../../src/pi-rpc/client";
import type {
  PiRpcCommandRequest,
  PiRpcExtensionUiResponse,
  PiRpcResponse,
} from "../../src/pi-rpc/types";
import type { MemoryExtractionJob } from "../../src/memory/types";

const temporaryDirectories: string[] = [];
const ORIGINAL_EXIT_SUMMARY_SYSTEM_PROMPT = [
  "You are a session recap assistant.",
  "Read the conversation and extract key decisions, lessons learned, notes, and follow-ups.",
  "Return ONLY markdown in the specified format, without any extra commentary.",
].join("\n");
const ORIGINAL_SERIALIZED_CONVERSATION = [
  "[User]: Summarize the release notes.",
  "[Assistant thinking]: Read the source first.",
  '[Assistant tool calls]: fetch_page(url="https://example.invalid/release")',
  "[Tool result]: Version 2 reduces memory use.",
  "[Assistant]: Version 2 mainly reduces memory use.",
].join("\n\n");
const VALID_SUMMARY = [
  "### Decisions",
  "- Keep the bridge asynchronous.",
  "### Lessons Learned",
  "None.",
  "### Notes",
  "- Worked on the bridge.",
  "### Follow-ups",
  "- Verify the deployment.",
].join("\n");
const ORIGINAL_EXIT_SUMMARY_PROMPT = [
  "Review the conversation and extract important decisions, lessons learned, notes, and follow-ups for a daily log.",
  "Return markdown only with these exact headings:",
  "### Decisions",
  "### Lessons Learned",
  "### Notes",
  "### Follow-ups",
  'Use bullet points under each heading. If there is nothing, write "None.".',
  "",
  "<conversation>",
  ORIGINAL_SERIALIZED_CONVERSATION,
  "</conversation>",
].join("\n");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

class ExtractionClient implements PiRpcClientLike {
  readonly prompts: string[] = [];
  readonly #listeners = new Set<PiRpcEventListener>();
  readonly #fatalListeners = new Set<PiRpcFatalListener>();
  closed = false;

  constructor(
    readonly responseText: string,
    readonly hang = false,
    readonly fatal = false,
    readonly responseParts?: readonly string[],
  ) {}

  dispatch(_command: PiRpcCommandRequest): PiRpcRequestHandle {
    throw new Error("not used");
  }

  async request(command: PiRpcCommandRequest): Promise<PiRpcResponse> {
    if (command.type !== "prompt") {
      throw new Error("unexpected command");
    }
    this.prompts.push(command.message);
    if (this.fatal) {
      for (const listener of this.#fatalListeners) {
        listener(new Error("worker exited"));
      }
      return new Promise(() => undefined);
    }
    if (this.hang) {
      return new Promise(() => undefined);
    }
    for (const listener of this.#listeners) {
      listener({
        type: "message_end",
        message: {
          role: "assistant",
          content: (this.responseParts ?? [this.responseText]).map((text) => ({
            type: "text" as const,
            text,
          })),
          stopReason: "stop",
          timestamp: 1,
        },
      });
      listener({ type: "agent_settled" });
    }
    return { type: "response", command: "prompt", success: true };
  }

  async notify(_response: PiRpcExtensionUiResponse): Promise<void> {}

  onEvent(listener: PiRpcEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onFatal(listener: PiRpcFatalListener): () => void {
    this.#fatalListeners.add(listener);
    return () => this.#fatalListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

describe("MemoryExtractor", () => {
  test("固定使用无 session、extension、tools、skills 和项目上下文的 Pi 参数", () => {
    expect(buildMemoryWorkerArgs("provider/model")).toEqual([
      "--no-session",
      "--no-extensions",
      "--no-tools",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--system-prompt",
      ORIGINAL_EXIT_SUMMARY_SYSTEM_PROMPT,
      "--model",
      "provider/model",
    ]);
  });

  test("使用原插件 Prompt 并保留工具调用和工具结果的会话序列化", async () => {
    const sessionFile = fileURLToPath(
      new URL("../fixtures/memory-exit-summary/session.jsonl", import.meta.url),
    );
    const source = await readFile(sessionFile);
    const client = new ExtractionClient(VALID_SUMMARY);
    const job: MemoryExtractionJob = {
      version: 1,
      chatId: 1,
      id: "extract:fixture",
      sessionId: "summary-session",
      sessionFile,
      fromOffset: 0,
      toOffset: source.length,
      capturedAt: Date.parse("2026-09-04T10:00:00.000Z"),
      status: "running",
      attempts: 1,
      nextAttemptAt: 0,
    };

    await createExtractor(client, 1_000).extract(job);

    expect(client.prompts).toEqual([ORIGINAL_EXIT_SUMMARY_PROMPT]);
  });

  test("只读取固定 JSONL 范围并保留所有原会话消息", async () => {
    const fixture = await createJob();
    const client = new ExtractionClient(VALID_SUMMARY);

    const entries = await createExtractor(client, 1_000).extract(fixture.job);

    expect(entries).toEqual([{ target: "daily", content: VALID_SUMMARY }]);
    expect(client.prompts[0]).toContain(
      "[User]: Please remember that I use Bun.",
    );
    expect(client.prompts[0]).toContain("[Tool result]: tool output secret");
    expect(client.prompts[0]).toContain("[Assistant]: Discarded wrong answer.");
    expect(client.prompts[0]).toContain("[Assistant]: I will remember that.");
    expect(client.closed).toBeTrue();
  });

  test("单条超长消息只保留 80,000 字符尾部", async () => {
    const fixture = await createJob("start:" + "x".repeat(300_000) + ":end");
    const client = new ExtractionClient(VALID_SUMMARY);

    await createExtractor(client, 1_000).extract(fixture.job);

    expect(client.prompts[0]).toContain(
      "Conversation transcript was truncated to the most recent 80000",
    );
    expect(client.prompts[0]).not.toContain("start:");
    expect(client.prompts[0]).toContain(":end");
  });

  test("多个 assistant 文本块按原插件行为用换行合并", async () => {
    const fixture = await createJob();
    const splitAt = VALID_SUMMARY.indexOf("### Notes");
    const client = new ExtractionClient("", false, false, [
      VALID_SUMMARY.slice(0, splitAt).trimEnd(),
      VALID_SUMMARY.slice(splitAt),
    ]);

    await expect(
      createExtractor(client, 1_000).extract(fixture.job),
    ).resolves.toEqual([{ target: "daily", content: VALID_SUMMARY }]);
  });

  test("少于四条消息时不启动独立 Pi client", async () => {
    const fixture = await createJob();
    const lines = (await readFile(fixture.job.sessionFile, "utf8"))
      .trimEnd()
      .split("\n");
    const source = `${lines.slice(0, 4).join("\n")}\n`;
    await writeFile(fixture.job.sessionFile, source);
    const client = new ExtractionClient(VALID_SUMMARY);

    await expect(
      createExtractor(client, 1_000).extract({
        ...fixture.job,
        toOffset: Buffer.byteLength(source),
      }),
    ).resolves.toEqual([]);
    expect(client.prompts).toEqual([]);
    expect(client.closed).toBeFalse();
  });

  test("空模型响应按原插件行为不写摘要", async () => {
    const fixture = await createJob();
    const client = new ExtractionClient("  ");

    await expect(
      createExtractor(client, 1_000).extract(fixture.job),
    ).resolves.toEqual([]);
    expect(client.closed).toBeTrue();
  });

  test("超时会取消等待并关闭独立 Pi client", async () => {
    const fixture = await createJob();
    const client = new ExtractionClient("", true);
    const extractor = createExtractor(client, 10);

    await expect(extractor.extract(fixture.job)).rejects.toThrow("aborted");
    expect(client.closed).toBeTrue();
  });

  test("独立 Pi client 异常退出会失败并关闭", async () => {
    const fixture = await createJob();
    const client = new ExtractionClient("", false, true);

    await expect(
      createExtractor(client, 1_000).extract(fixture.job),
    ).rejects.toThrow("worker exited");
    expect(client.closed).toBeTrue();
  });

  test("拒绝 checkpoint 后被替换的 session 文件", async () => {
    const fixture = await createJob();
    const source = await stat(fixture.job.sessionFile);
    const checkedJob: MemoryExtractionJob = {
      ...fixture.job,
      sourceDevice: source.dev,
      sourceInode: source.ino,
    };
    await rename(
      fixture.job.sessionFile,
      join(fixture.directory, "original-session.jsonl"),
    );
    await writeFile(
      fixture.job.sessionFile,
      " ".repeat(fixture.job.toOffset - 1) + "\n",
    );

    await expect(
      createExtractor(new ExtractionClient(VALID_SUMMARY), 1_000).extract(
        checkedJob,
      ),
    ).rejects.toThrow("identity changed");
  });

  test("按原插件行为保留非空模型 Markdown", async () => {
    const fixture = await createJob();
    const response = VALID_SUMMARY.replace("### Notes", "### Observations");
    const client = new ExtractionClient(response);

    await expect(
      createExtractor(client, 1_000).extract(fixture.job),
    ).resolves.toEqual([{ target: "daily", content: response }]);
  });
});

function createExtractor(
  client: PiRpcClientLike,
  timeoutMs: number,
): MemoryExtractor {
  return new MemoryExtractor({
    command: "pi",
    cwd: "/tmp",
    sessionDir: "/tmp/sessions",
    timeoutMs,
    createClient: () => client,
  });
}

async function createJob(
  userContent = "Please remember that I use Bun.",
): Promise<{
  directory: string;
  job: MemoryExtractionJob;
}> {
  const directory = await mkdtemp(join(tmpdir(), "amadeus-memory-extractor-"));
  temporaryDirectories.push(directory);
  const sessionFile = join(directory, "session.jsonl");
  const source =
    [
      { type: "session", id: "s1" },
      {
        type: "message",
        message: { role: "user", content: userContent },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          content: "tool output secret",
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Discarded wrong answer." }],
          stopReason: "aborted",
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I will remember that." }],
          stopReason: "stop",
        },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n";
  await writeFile(sessionFile, source);
  return {
    directory,
    job: {
      version: 1,
      chatId: 1,
      id: `extract:1:s1:0:${Buffer.byteLength(source)}`,
      sessionId: "s1",
      sessionFile,
      fromOffset: 0,
      toOffset: Buffer.byteLength(source),
      status: "running",
      attempts: 1,
      nextAttemptAt: 0,
    },
  };
}
