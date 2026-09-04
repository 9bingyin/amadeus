import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
          content: [{ type: "text", text: this.responseText }],
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
      "--model",
      "provider/model",
    ]);
  });

  test("只读取固定 JSONL 范围并解析固定 JSON 输出", async () => {
    const fixture = await createJob();
    const client = new ExtractionClient(
      JSON.stringify({
        version: 1,
        entries: [
          { target: "long_term", content: "#preference Uses Bun" },
          {
            target: "daily",
            date: "2026-09-04",
            content: "Worked on the bridge",
          },
        ],
      }),
    );
    const extractor = createExtractor(client, 1_000);

    const entries = await extractor.extract(fixture.job);

    expect(entries).toEqual([
      { target: "long_term", content: "#preference Uses Bun" },
      {
        target: "daily",
        date: "2026-09-04",
        content: "Worked on the bridge",
      },
    ]);
    expect(client.prompts[0]).toContain(
      JSON.stringify([
        { role: "user", text: "Please remember that I use Bun." },
        { role: "assistant", text: "I will remember that." },
      ]),
    );
    expect(client.prompts[0]).not.toContain("tool output secret");
    expect(client.prompts[0]).not.toContain("Discarded wrong answer");
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
      createExtractor(
        new ExtractionClient('{"version":1,"entries":[]}'),
        1_000,
      ).extract(checkedJob),
    ).rejects.toThrow("identity changed");
  });

  test("拒绝 Markdown fence、未知字段和无效 entry", async () => {
    const fixture = await createJob();
    const fenced = new ExtractionClient(
      '```json\n{"version":1,"entries":[]}\n```',
    );
    await expect(
      createExtractor(fenced, 1_000).extract(fixture.job),
    ).rejects.toThrow("not valid JSON");

    const unknown = new ExtractionClient(
      JSON.stringify({ version: 1, entries: [], explanation: "none" }),
    );
    await expect(
      createExtractor(unknown, 1_000).extract(fixture.job),
    ).rejects.toThrow("unknown fields");
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

async function createJob(): Promise<{
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
        message: { role: "user", content: "Please remember that I use Bun." },
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
