import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  PiAgentManager,
  type PiFinalResponse,
} from "../../src/bridge/agent-manager";
import { createInfoLogger } from "../../src/logging/logger";
import { createPiRpcClientFactory } from "../../src/pi-rpc/client-factory";
import { StateStore } from "../../src/state";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("fake Pi RPC subprocess", () => {
  test("通过真实 stdin/stdout JSONL 完成 prompt、事件和 session 持久化", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-fake-pi-"));
    temporaryDirectories.push(directory);
    const sessionDir = join(directory, "sessions");
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const finals: PiFinalResponse[] = [];
    const lines: string[] = [];
    const logger = createInfoLogger({
      now: () => new Date("2026-09-01T00:00:00Z"),
      writeLine: (line) => lines.push(line),
    });
    const userText = "hello subprocess private message";
    const manager = new PiAgentManager({
      stateStore,
      downloader: { download: async (attachment) => attachment },
      clientFactory: createPiRpcClientFactory({
        command: resolve("test/fixtures/pi-rpc/run"),
        cwd: resolve("."),
        args: [],
        sessionDir,
        logger,
      }),
      logger,
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async (response) => {
          finals.push(response);
        },
        onSessionReset: async () => undefined,
        onError: async (_chatId, error) => {
          throw error;
        },
      },
    });

    await manager.submit({
      updateId: 1,
      chatId: 1,
      messageId: 10,
      sentAt: "2026-09-01T00:00:00Z",
      sender: { id: 1, displayName: "User" },
      text: userText,
      attachments: [],
    });
    await waitFor(() => finals.length === 1);
    await manager.close();

    expect(finals[0]).toMatchObject({
      chatId: 1,
      replyToMessageId: 10,
      piEntryId: "assistant-entry-1",
      text: "fake process reply",
    });
    expect(stateStore.snapshot().chats["1"]?.session?.id).toBe(
      "fake-session-1",
    );
    expect(stateStore.snapshot().chats["1"]?.messages["10"]?.text).toBe(
      userText,
    );
    const output = lines.join("\n");
    expect(output).toContain("event=pi_agent_create_started");
    expect(output).toContain("event=pi_session_ready");
    expect(output).toContain("event=pi_prompt_sent");
    expect(output).toContain("event=pi_tool_started");
    expect(output).toContain("event=pi_tool_finished");
    expect(output).toContain("event=pi_agent_settled");
    expect(output).not.toContain(userText);
    expect(output).not.toContain("fake process reply");
    expect(output).not.toContain("private-tool-call-id");
    expect(output).not.toContain("private shell command");
    expect(output).not.toContain("private tool output");
    expect(
      lines.every((line) => line.includes(" level=info event=")),
    ).toBeTrue();
    expect(lines.every((line) => !line.includes("\n"))).toBeTrue();
    expect(output).not.toMatch(/[\u4e00-\u9fff]/);
  });

  test("真实 fake 子进程异常退出会走 fatal 并绑定触发消息", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-fake-pi-crash-"));
    temporaryDirectories.push(directory);
    const sessionDir = join(directory, "sessions");
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const failures: Array<{ message: string; replyTo?: number }> = [];
    const manager = new PiAgentManager({
      stateStore,
      downloader: { download: async (attachment) => attachment },
      clientFactory: createPiRpcClientFactory({
        command: resolve("test/fixtures/pi-rpc/run"),
        cwd: resolve("."),
        args: ["--crash-after-prompt"],
        sessionDir,
      }),
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async (_chatId, error, replyToMessageId) => {
          failures.push({
            message: error.message,
            ...(replyToMessageId !== undefined
              ? { replyTo: replyToMessageId }
              : {}),
          });
        },
      },
    });

    await manager.submit({
      updateId: 2,
      chatId: 1,
      messageId: 20,
      sentAt: "2026-09-01T00:00:00Z",
      sender: { id: 1, displayName: "User" },
      text: "crash process",
      attachments: [],
    });
    await waitFor(() => failures.length === 1);
    await manager.close();

    expect(failures[0]?.message).toContain("状态码 7");
    expect(failures[0]?.replyTo).toBe(20);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error("等待 fake Pi RPC 子进程超时");
}
