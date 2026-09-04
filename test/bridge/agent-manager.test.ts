import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeMemoryUiRequest,
  MEMORY_PROTOCOL_TITLE,
} from "../../plugins/memory/protocol";
import { BridgeLifecycle } from "../../src/bridge/lifecycle";
import {
  MemoryCoordinator,
  type MemoryExtractionRunner,
} from "../../src/memory/coordinator";
import { MemoryStore } from "../../src/memory/store";
import type { NormalizedTelegramMessage } from "../../src/telegram/types";
import {
  PiAgentManager,
  type PiFinalResponse,
  type PiTextStreamEvent,
  type PiTextStreamGeneration,
} from "../../src/bridge/agent-manager";
import type {
  PiRpcClientLike,
  PiRpcEventListener,
  PiRpcFatalListener,
  PiRpcRequestHandle,
} from "../../src/pi-rpc/client";
import {
  PiSessionFileMissingError,
  type PiRpcClientFactory,
} from "../../src/pi-rpc/client-factory";
import type { PiSessionLaunchMode } from "../../src/pi-rpc/transport";
import { parsePiRpcOutput } from "../../src/pi-rpc/parser";
import type {
  PiRpcCommandRequest,
  PiRpcEvent,
  PiRpcExtensionUiResponse,
  PiRpcResponse,
} from "../../src/pi-rpc/types";
import { StateStore } from "../../src/state";
import { TelegramDownloadError } from "../../src/telegram/download";
import { RecordingLogger } from "../helpers/recording-logger";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

class FakePiClient implements PiRpcClientLike {
  readonly sessionLaunchMode: PiSessionLaunchMode;
  readonly requests: PiRpcCommandRequest[] = [];
  closed = false;
  compactError: string | undefined;
  readonly notifications: PiRpcExtensionUiResponse[] = [];
  readonly #listeners = new Set<PiRpcEventListener>();
  readonly #fatalListeners = new Set<PiRpcFatalListener>();
  #isStreaming = false;
  #abortResolvers: Array<(response: PiRpcResponse) => void> = [];
  #sessionId: string;
  #sessionFile: string;
  readonly #cancelNewSession: boolean;
  readonly #newSessionFile: string;

  constructor(
    sessionId = "session-1",
    sessionFile = "/sessions/session-1.jsonl",
    cancelNewSession = false,
    newSessionFile = "/sessions/session-2.jsonl",
    sessionLaunchMode: PiSessionLaunchMode = "resume",
  ) {
    this.sessionLaunchMode = sessionLaunchMode;
    this.#sessionId = sessionId;
    this.#sessionFile = sessionFile;
    this.#cancelNewSession = cancelNewSession;
    this.#newSessionFile = newSessionFile;
  }

  dispatch(command: PiRpcCommandRequest): PiRpcRequestHandle {
    this.requests.push(command);
    if (command.type !== "abort") {
      return {
        sent: Promise.resolve(),
        response: Promise.resolve(this.responseFor(command)),
      };
    }
    return {
      sent: Promise.resolve(),
      response: new Promise((resolve) => {
        this.#abortResolvers.push(resolve);
      }),
    };
  }

  async request(command: PiRpcCommandRequest): Promise<PiRpcResponse> {
    this.requests.push(command);
    return this.responseFor(command);
  }

  responseFor(command: PiRpcCommandRequest): PiRpcResponse {
    if (command.type === "get_state") {
      return {
        type: "response",
        command: command.type,
        success: true,
        data: {
          model: { provider: "openai-codex", id: "gpt-5.6-sol" },
          thinkingLevel: "high",
          isStreaming: this.#isStreaming,
          isCompacting: false,
          steeringMode: "one-at-a-time",
          followUpMode: "one-at-a-time",
          sessionFile: this.#sessionFile,
          sessionId: this.#sessionId,
          pendingMessageCount: 0,
        },
      };
    }
    if (command.type === "get_session_stats") {
      return {
        type: "response",
        command: command.type,
        success: true,
        data: {
          sessionId: this.#sessionId,
          contextUsage: {
            tokens: 120_000,
            contextWindow: 200_000,
            percent: 60,
          },
        },
      };
    }
    if (command.type === "compact") {
      if (this.compactError) {
        return {
          type: "response",
          command: command.type,
          success: false,
          error: this.compactError,
        };
      }
      return {
        type: "response",
        command: command.type,
        success: true,
        data: {
          summary: "private summary",
          firstKeptEntryId: "entry-1",
          tokensBefore: 150_000,
          estimatedTokensAfter: 32_000,
        },
      };
    }
    if (command.type === "get_entries") {
      return {
        type: "response",
        command: command.type,
        success: true,
        data: {
          entries: [
            {
              type: "message",
              id: "assistant-entry-1",
              parentId: "user-entry-1",
              message: { role: "assistant" },
            },
          ],
          leafId: "assistant-entry-1",
        },
      };
    }
    if (command.type === "clear_queue") {
      return {
        type: "response",
        command: command.type,
        success: true,
        data: { steering: [], followUp: [] },
      };
    }
    if (command.type === "abort") {
      this.#isStreaming = false;
    }
    if (command.type === "new_session") {
      if (!this.#cancelNewSession) {
        this.#sessionId = "session-2";
        this.#sessionFile = this.#newSessionFile;
      }
      return {
        type: "response",
        command: command.type,
        success: true,
        data: { cancelled: this.#cancelNewSession },
      };
    }
    return { type: "response", command: command.type, success: true };
  }

  async notify(message: PiRpcExtensionUiResponse): Promise<void> {
    this.notifications.push(message);
  }

  onEvent(listener: PiRpcEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onFatal(listener: PiRpcFatalListener): () => void {
    this.#fatalListeners.add(listener);
    return () => this.#fatalListeners.delete(listener);
  }

  emitFatal(error: Error): void {
    for (const listener of this.#fatalListeners) {
      listener(error);
    }
  }

  emit(event: PiRpcEvent): void {
    if (event.type === "agent_start") {
      this.#isStreaming = true;
    } else if (event.type === "agent_settled") {
      this.#isStreaming = false;
      for (const resolve of this.#abortResolvers.splice(0)) {
        resolve({ type: "response", command: "abort", success: true });
      }
    }
    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

describe("PiAgentManager", () => {
  test("运行中按 steer→abort 保留新消息，并只交付最后有效回复", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient();
    const finals: PiFinalResponse[] = [];
    const factory: PiRpcClientFactory = { create: async () => client };
    const logger = new RecordingLogger();
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: factory,
      downloader: { download: async (attachment) => attachment },
      logger,
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async (response) => {
          finals.push(response);
        },
        onSessionReset: async () => undefined,
        onError: async (chatId, error) => {
          throw new Error(`chat ${chatId}: ${error.message}`);
        },
      },
    });

    await manager.submit(message(1, "first"));
    await waitFor(() =>
      client.requests.some((request) => request.type === "prompt"),
    );
    client.emit({ type: "agent_start" });
    await manager.submit(message(2, "second"));
    await waitFor(() =>
      client.requests.some((request) => request.type === "abort"),
    );
    await manager.submit(message(3, "third"));
    await waitFor(
      () =>
        client.requests.filter((request) => request.type === "abort").length ===
        2,
    );
    client.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "stale" }],
        stopReason: "aborted",
        timestamp: 1,
      },
    });
    const steeringMessages = client.requests.flatMap((request) =>
      request.type === "steer" ? [request.message] : [],
    );
    for (const content of steeringMessages) {
      client.emit({
        type: "message_end",
        message: { role: "user", content },
      });
    }
    client.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "final" }],
        stopReason: "stop",
        timestamp: 2,
      },
    });
    client.emit({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "secret command" },
    });
    client.emit({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "bash",
      result: { output: "secret output" },
      isError: false,
    });
    client.emit({ type: "agent_settled" });
    await Promise.resolve();
    await manager.close();

    const requestTypes = client.requests.map((request) => request.type);
    expect(requestTypes.slice(0, 11)).toEqual([
      "get_state",
      "set_steering_mode",
      "get_state",
      "prompt",
      "get_state",
      "steer",
      "abort",
      "get_state",
      "steer",
      "abort",
      "get_state",
    ]);
    expect(requestTypes.slice(11).sort()).toEqual(["get_entries", "get_state"]);
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({
      chatId: 1,
      replyToMessageId: 3,
      sessionId: "session-1",
      piEntryId: "assistant-entry-1",
      text: "final",
      stopReason: "stop",
    });
    expect(stateStore.snapshot().chats["1"]?.messages["2"]?.text).toBe(
      "second",
    );
    expect(stateStore.snapshot().chats["1"]?.messages["3"]?.text).toBe("third");
    expect(logger.events()).toEqual(
      expect.arrayContaining([
        "pi_agent_create_started",
        "pi_session_ready",
        "pi_prompt_sent",
        "pi_steer_sent",
        "pi_abort_sent",
        "pi_abort_completed",
        "pi_response_suppressed",
        "pi_tool_started",
        "pi_tool_finished",
        "pi_agent_settled",
      ]),
    );
    expect(JSON.stringify(logger.entries)).not.toContain("secret command");
    expect(JSON.stringify(logger.entries)).not.toContain("secret output");
    expect(JSON.stringify(logger.entries)).not.toContain("<tg");
  });

  test("把 Pi text_delta 绑定到当前 revision 并在最终发送前结束草稿", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient();
    const streamEvents: PiTextStreamEvent[] = [];
    const finished: PiTextStreamGeneration[] = [];
    const finals: PiFinalResponse[] = [];
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onTextStream: (_chatId, event) => streamEvents.push(event),
        onTextStreamFinish: async (_chatId, generation) => {
          finished.push(generation);
        },
        onFinalResponse: async (response) => {
          finals.push(response);
        },
        onSessionReset: async () => undefined,
        onError: async (_chatId, error) => {
          throw error;
        },
      },
    });

    await manager.submit(message(20, "stream"));
    await waitFor(() =>
      client.requests.some((request) => request.type === "prompt"),
    );
    client.emit({ type: "agent_start" });
    client.emit({ type: "message_start", messageRole: "assistant" });
    client.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "hello",
      },
    });
    client.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        stopReason: "stop",
        timestamp: 1,
      },
    });
    client.emit({ type: "agent_settled" });
    await waitFor(() => finals.length === 1);
    await manager.close();

    const generation = { revision: 1, segment: 1 };
    expect(streamEvents).toEqual([
      {
        type: "start",
        generation,
        replyToMessageId: 20,
      },
      { type: "delta", generation, text: "hello" },
    ]);
    expect(finished).toEqual([generation]);
    expect(finals[0]?.text).toBe("hello");
  });

  test("新 Telegram 消息入队时立即中止旧草稿 generation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient();
    const streamEvents: PiTextStreamEvent[] = [];
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onTextStream: (_chatId, event) => streamEvents.push(event),
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async () => undefined,
      },
    });

    await manager.submit(message(30, "first"));
    await waitFor(() =>
      client.requests.some((request) => request.type === "prompt"),
    );
    client.emit({ type: "agent_start" });
    client.emit({ type: "message_start", messageRole: "assistant" });
    await manager.submit(message(31, "newer"));
    await waitFor(() => streamEvents.some((event) => event.type === "abort"));
    client.emit({ type: "agent_settled" });
    await manager.close();

    expect(streamEvents).toEqual([
      {
        type: "start",
        generation: { revision: 1, segment: 1 },
        replyToMessageId: 30,
      },
      {
        type: "abort",
        generation: { revision: 1, segment: 1 },
      },
    ]);
  });

  test("已索引的同 chat message_id 不会再次提交给 Pi", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient();
    const logger = new RecordingLogger();
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      logger,
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async (_chatId, error) => {
          throw error;
        },
      },
    });

    await manager.submit(message(9, "once"));
    await waitFor(
      () => stateStore.snapshot().chats["1"]?.messages["9"] !== undefined,
    );
    await manager.submit(message(9, "duplicate"));
    await Promise.resolve();
    await manager.close();

    expect(
      client.requests.filter((item) => item.type === "prompt"),
    ).toHaveLength(1);
    expect(logger.events()).toContain("pi_input_suppressed");
  });

  test("steer 后旧回答正常 stop 也不会被误认作新回答", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient();
    const finals: string[] = [];
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async (response) => {
          finals.push(response.text);
        },
        onSessionReset: async () => undefined,
        onError: async (_chatId, error) => {
          throw error;
        },
      },
    });

    await manager.submit(message(1, "first"));
    await waitFor(
      () =>
        client.requests.filter((item) => item.type === "prompt").length === 1,
    );
    client.emit({ type: "agent_start" });
    await manager.submit(message(2, "latest"));
    await waitFor(() => client.requests.some((item) => item.type === "abort"));
    client.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "old normal stop" }],
        stopReason: "stop",
        timestamp: 1,
      },
    });
    client.emit({ type: "agent_settled" });
    await waitFor(
      () =>
        client.requests.filter((item) => item.type === "prompt").length === 2,
    );

    expect(finals).toEqual([]);
    const recovery = client.requests.filter(
      (item) => item.type === "prompt",
    )[1];
    expect(recovery).toMatchObject({
      streamingBehavior: "steer",
      message: expect.stringContaining("latest"),
    });

    client.emit({ type: "agent_start" });
    client.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "new final" }],
        stopReason: "stop",
        timestamp: 2,
      },
    });
    client.emit({ type: "agent_settled" });
    await manager.close();

    expect(finals).toEqual(["new final"]);
  });

  test("空文本 Pi error 会回复触发消息", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient();
    const failures: Array<{ text: string; replyTo?: number }> = [];
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async (_chatId, error, replyToMessageId) => {
          failures.push({
            text: error.message,
            ...(replyToMessageId !== undefined
              ? { replyTo: replyToMessageId }
              : {}),
          });
        },
      },
    });

    await manager.submit(message(42, "cause error"));
    await waitFor(() => client.requests.some((item) => item.type === "prompt"));
    client.emit({ type: "agent_start" });
    client.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "model failed",
        timestamp: 1,
      },
    });
    client.emit({ type: "agent_settled" });
    await waitFor(() => failures.length === 1);
    await manager.close();

    expect(failures).toEqual([{ text: "model failed", replyTo: 42 }]);
  });

  test("abort 吞掉 steer 时会用本地 payload 重新 prompt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient();
    const finals: PiFinalResponse[] = [];
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
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

    await manager.submit(message(1, "first"));
    await waitFor(
      () =>
        client.requests.filter((item) => item.type === "prompt").length === 1,
    );
    client.emit({ type: "agent_start" });
    await manager.submit(message(2, "must survive"));
    await waitFor(() => client.requests.some((item) => item.type === "abort"));
    client.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "aborted",
        timestamp: 1,
      },
    });
    client.emit({ type: "agent_settled" });

    await waitFor(
      () =>
        client.requests.filter((item) => item.type === "prompt").length === 2,
    );
    client.emit({ type: "agent_start" });
    client.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "recovered" }],
        stopReason: "stop",
        timestamp: 2,
      },
    });
    client.emit({ type: "agent_settled" });
    await manager.close();

    const prompts = client.requests.filter((item) => item.type === "prompt");
    expect(prompts[1]).toMatchObject({
      message: expect.stringContaining("must survive"),
    });
    expect(finals.map((item) => item.text)).toEqual(["recovered"]);
  });

  test("abort 把已激活 steer 记为 error 时不会向用户报处理失败", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient();
    const failures: Array<{ text: string; replyTo?: number }> = [];
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async (_chatId, error, replyToMessageId) => {
          failures.push({
            text: error.message,
            ...(replyToMessageId !== undefined
              ? { replyTo: replyToMessageId }
              : {}),
          });
        },
      },
    });

    await manager.submit(message(1, "location"));
    await waitFor(
      () =>
        client.requests.filter((item) => item.type === "prompt").length === 1,
    );
    client.emit({ type: "agent_start" });
    await manager.submit(message(2, "这是哪里"));
    await waitFor(() => client.requests.some((item) => item.type === "abort"));
    const steer = client.requests.find((item) => item.type === "steer");
    if (!steer || steer.type !== "steer") {
      throw new Error("预期发送 steer");
    }
    client.emit({
      type: "message_end",
      message: { role: "user", content: steer.message },
    });
    client.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "The operation was aborted.",
        timestamp: 1,
      },
    });
    client.emit({ type: "agent_settled" });

    await waitFor(
      () =>
        failures.length > 0 ||
        client.requests.filter((item) => item.type === "prompt").length === 2,
    );
    await manager.close();

    expect(failures).toEqual([]);
    expect(
      client.requests.filter((item) => item.type === "prompt"),
    ).toHaveLength(2);
  });

  test("恢复多个被 abort 吞掉的消息时保持独立 RPC prompt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient();
    const logger = new RecordingLogger();
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      logger,
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async (_chatId, error) => {
          throw error;
        },
      },
    });

    await manager.submit(message(1, "first"));
    await waitFor(
      () =>
        client.requests.filter((item) => item.type === "prompt").length === 1,
    );
    client.emit({ type: "agent_start" });
    await manager.submit(message(2, "second independent"));
    await manager.submit(message(3, "third independent"));
    await waitFor(
      () =>
        client.requests.filter((item) => item.type === "abort").length === 2,
    );
    client.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "aborted",
        timestamp: 1,
      },
    });
    client.emit({ type: "agent_settled" });
    await waitFor(
      () =>
        client.requests.filter((item) => item.type === "prompt").length === 3 &&
        logger.events().includes("pi_queue_recovery_succeeded"),
    );

    const recoveryPrompts = client.requests
      .filter((item) => item.type === "prompt")
      .slice(1);
    expect(recoveryPrompts).toHaveLength(2);
    expect(recoveryPrompts[0]).toMatchObject({
      streamingBehavior: "steer",
      message: expect.stringContaining("second independent"),
    });
    expect(recoveryPrompts[0]).not.toMatchObject({
      message: expect.stringContaining("third independent"),
    });
    expect(recoveryPrompts[1]).toMatchObject({
      streamingBehavior: "steer",
      message: expect.stringContaining("third independent"),
    });
    expect(recoveryPrompts[1]).not.toMatchObject({
      message: expect.stringContaining("second independent"),
    });
    expect(logger.events()).toEqual(
      expect.arrayContaining([
        "pi_queue_recovery_started",
        "pi_queue_recovery_succeeded",
      ]),
    );
    await manager.close();
  });

  test("/compact 只在实际压缩期间发送活动回调", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient();
    const activity: string[] = [];
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onCompactionStart: () => activity.push("start"),
        onCompactionFinish: async () => {
          activity.push("finish");
        },
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async (_chatId, error) => {
          throw error;
        },
      },
    });

    expect(await manager.compact(1)).toEqual({
      status: "compacted",
      tokensBefore: 150_000,
      estimatedTokensAfter: 32_000,
    });
    expect(activity).toEqual(["start", "finish"]);
    await manager.close();
  });

  test("/compact 将过小或刚压缩的上下文作为无需压缩", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient();
    client.compactError = "Nothing to compact (session too small)";
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async (_chatId, error) => {
          throw error;
        },
      },
    });

    expect(await manager.compact(1)).toEqual({ status: "not_needed" });
    client.compactError = "Already compacted";
    expect(await manager.compact(1)).toEqual({ status: "not_needed" });
    await manager.close();
  });

  test("/stop 中止当前处理、抑制晚到回复并保留 session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient();
    const finals: PiFinalResponse[] = [];
    const streams: PiTextStreamEvent[] = [];
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onTextStream: (_chatId, event) => {
          streams.push(event);
        },
        onFinalResponse: async (response) => {
          finals.push(response);
        },
        onSessionReset: async () => undefined,
        onError: async (_chatId, error) => {
          throw error;
        },
      },
    });

    await manager.submit(message(75, "long request"));
    await waitFor(() =>
      client.requests.some((request) => request.type === "prompt"),
    );
    expect(await manager.compact(1)).toEqual({ status: "busy" });
    expect(
      client.requests.some((request) => request.type === "compact"),
    ).toBeFalse();
    client.emit({ type: "message_start", messageRole: "assistant" });
    client.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "before stop",
      },
    });

    const stopping = manager.stop(1, 76);
    await waitFor(() =>
      client.requests.some((request) => request.type === "abort"),
    );
    client.emit({ type: "message_start", messageRole: "assistant" });
    client.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "after stop",
      },
    });
    client.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "late response" }],
        stopReason: "stop",
        timestamp: 1,
      },
    });
    client.emit({ type: "agent_settled" });

    expect(await stopping).toBeTrue();
    expect(await manager.stop(1, 77)).toBeFalse();
    expect(await manager.compact(1)).toEqual({
      status: "compacted",
      tokensBefore: 150_000,
      estimatedTokensAfter: 32_000,
    });
    await manager.close();

    expect(finals).toEqual([]);
    expect(streams.map((event) => event.type)).toEqual([
      "start",
      "delta",
      "abort",
    ]);
    expect(stateStore.snapshot().chats["1"]?.session?.id).toBe("session-1");
    expect(
      client.requests.some((request) => request.type === "new_session"),
    ).toBeFalse();
  });

  test("/stop 不会恢复在停止期间完成提交的 steer", async () => {
    class DelayedSteerClient extends FakePiClient {
      #releaseSteer: (() => void) | undefined;

      override async request(
        command: PiRpcCommandRequest,
      ): Promise<PiRpcResponse> {
        this.requests.push(command);
        if (command.type === "steer") {
          await new Promise<void>((resolve) => {
            this.#releaseSteer = resolve;
          });
        }
        return this.responseFor(command);
      }

      releaseSteer(): void {
        this.#releaseSteer?.();
      }
    }

    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new DelayedSteerClient();
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async (_chatId, error) => {
          throw error;
        },
      },
    });

    await manager.submit(message(79, "first"));
    await waitFor(() =>
      client.requests.some((request) => request.type === "prompt"),
    );
    client.emit({ type: "agent_start" });
    await manager.submit(message(80, "second"));
    await waitFor(() =>
      client.requests.some((request) => request.type === "steer"),
    );

    const stopping = manager.stop(1, 81);
    client.releaseSteer();
    await waitFor(() =>
      client.requests.some((request) => request.type === "abort"),
    );
    client.emit({ type: "agent_settled" });

    expect(await stopping).toBeTrue();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      client.requests.filter((request) => request.type === "prompt"),
    ).toHaveLength(1);
    await manager.close();
  });

  test("/stop 不会上报已经失效的 steer 错误", async () => {
    class FailingSteerClient extends FakePiClient {
      #rejectSteer: ((error: Error) => void) | undefined;

      override async request(
        command: PiRpcCommandRequest,
      ): Promise<PiRpcResponse> {
        this.requests.push(command);
        if (command.type === "steer") {
          return await new Promise<PiRpcResponse>((_resolve, reject) => {
            this.#rejectSteer = reject;
          });
        }
        return this.responseFor(command);
      }

      failSteer(): void {
        this.#rejectSteer?.(new Error("steer failed"));
      }
    }

    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FailingSteerClient();
    const errors: Error[] = [];
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async (_chatId, error) => {
          errors.push(error);
        },
      },
    });

    await manager.submit(message(85, "first"));
    await waitFor(() =>
      client.requests.some((request) => request.type === "prompt"),
    );
    client.emit({ type: "agent_start" });
    await manager.submit(message(86, "second"));
    await waitFor(() =>
      client.requests.some((request) => request.type === "steer"),
    );

    const stopping = manager.stop(1, 87);
    client.failSteer();
    await waitFor(() =>
      client.requests.some((request) => request.type === "abort"),
    );
    client.emit({ type: "agent_settled" });

    expect(await stopping).toBeTrue();
    expect(errors).toEqual([]);
    await manager.close();
  });

  test("/stop 会取消正在等待 clear_queue 的旧恢复操作", async () => {
    class DelayedRecoveryClient extends FakePiClient {
      #stateRequests = 0;
      #releaseClear: (() => void) | undefined;

      override async request(
        command: PiRpcCommandRequest,
      ): Promise<PiRpcResponse> {
        this.requests.push(command);
        if (command.type === "clear_queue") {
          await new Promise<void>((resolve) => {
            this.#releaseClear = resolve;
          });
        }
        return this.responseFor(command);
      }

      override responseFor(command: PiRpcCommandRequest): PiRpcResponse {
        if (command.type === "get_state") {
          this.#stateRequests += 1;
          const response = super.responseFor(command);
          if (this.#stateRequests === 2 && response.success) {
            return {
              ...response,
              data: {
                model: { provider: "openai-codex", id: "gpt-5.6-sol" },
                thinkingLevel: "high",
                isStreaming: false,
                isCompacting: false,
                steeringMode: "all",
                followUpMode: "one-at-a-time",
                sessionFile: "/sessions/session-1.jsonl",
                sessionId: "session-1",
                pendingMessageCount: 1,
              },
            };
          }
          return response;
        }
        if (command.type === "clear_queue") {
          return {
            type: "response",
            command: command.type,
            success: true,
            data: { steering: ["queued"], followUp: [] },
          };
        }
        return super.responseFor(command);
      }

      releaseClear(): void {
        this.#releaseClear?.();
      }
    }

    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new DelayedRecoveryClient();
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async (_chatId, error) => {
          throw error;
        },
      },
    });

    await manager.submit(message(88, "queued"));
    await waitFor(() =>
      client.requests.some((request) => request.type === "clear_queue"),
    );
    const stopping = manager.stop(1, 89);
    client.releaseClear();

    expect(await stopping).toBeTrue();
    expect(
      client.requests.filter((request) => request.type === "prompt"),
    ).toHaveLength(0);
    await manager.close();
  });

  test("/stop 在队列快照过期后仍继续中止活跃请求", async () => {
    class ActivatingQueueClient extends FakePiClient {
      #stateRequests = 0;

      override responseFor(command: PiRpcCommandRequest): PiRpcResponse {
        if (command.type === "get_state") {
          this.#stateRequests += 1;
          const response = super.responseFor(command);
          if (!response.success) {
            return response;
          }
          return {
            ...response,
            data: {
              model: { provider: "openai-codex", id: "gpt-5.6-sol" },
              thinkingLevel: "high",
              isStreaming: this.#stateRequests > 2,
              isCompacting: false,
              steeringMode: "all",
              followUpMode: "one-at-a-time",
              sessionFile: "/sessions/session-1.jsonl",
              sessionId: "session-1",
              pendingMessageCount: this.#stateRequests === 2 ? 1 : 0,
            },
          };
        }
        return super.responseFor(command);
      }
    }

    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new ActivatingQueueClient();
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async (_chatId, error) => {
          throw error;
        },
      },
    });

    const stopping = manager.stop(1, 82);
    await waitFor(() =>
      client.requests.some((request) => request.type === "abort"),
    );
    client.emit({ type: "agent_settled" });

    expect(await stopping).toBeTrue();
    expect(
      client.requests.some((request) => request.type === "clear_queue"),
    ).toBeTrue();
    await manager.close();
  });

  test("/stop 通过重启同一 session 中止上下文压缩", async () => {
    class HangingCompactClient extends FakePiClient {
      #rejectCompact: ((error: Error) => void) | undefined;

      override async request(
        command: PiRpcCommandRequest,
      ): Promise<PiRpcResponse> {
        this.requests.push(command);
        if (command.type === "compact") {
          return await new Promise<PiRpcResponse>((_resolve, reject) => {
            this.#rejectCompact = reject;
          });
        }
        return this.responseFor(command);
      }

      override async close(): Promise<void> {
        this.closed = true;
        this.#rejectCompact?.(new Error("RPC client closed"));
      }
    }

    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const oldClient = new HangingCompactClient(
      "session-1",
      "/sessions/session-1.jsonl",
    );
    const replacement = new FakePiClient(
      "session-1",
      "/sessions/session-1.jsonl",
    );
    let createCount = 0;
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: {
        create: async () => {
          createCount += 1;
          return createCount === 1 ? oldClient : replacement;
        },
      },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async (_chatId, error) => {
          throw error;
        },
      },
    });

    const compaction = manager.compact(1);
    await waitFor(() =>
      oldClient.requests.some((request) => request.type === "compact"),
    );
    const stopped = await manager.stop(1, 84);

    expect(stopped).toBeTrue();
    expect(await compaction).toEqual({ status: "cancelled" });
    expect(oldClient.closed).toBeTrue();
    expect(createCount).toBe(2);
    expect((await manager.status(1)).sessionId).toBe("session-1");
    await manager.close();
  });

  test("Pi fatal 不会把压缩失败误报为用户取消", async () => {
    class FailingCompactClient extends FakePiClient {
      #rejectCompact: ((error: Error) => void) | undefined;

      override async request(
        command: PiRpcCommandRequest,
      ): Promise<PiRpcResponse> {
        this.requests.push(command);
        if (command.type === "compact") {
          return await new Promise<PiRpcResponse>((_resolve, reject) => {
            this.#rejectCompact = reject;
          });
        }
        return this.responseFor(command);
      }

      fail(): void {
        const error = new Error("process failed");
        this.#rejectCompact?.(error);
        this.emitFatal(error);
      }
    }

    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FailingCompactClient();
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async () => undefined,
      },
    });

    const compaction = manager.compact(1);
    await waitFor(() =>
      client.requests.some((request) => request.type === "compact"),
    );
    client.fail();

    await expect(compaction).rejects.toThrow("process failed");
    await manager.close();
  });

  test("/stop 清空后端待处理队列但不新建 session", async () => {
    class QueuedPiClient extends FakePiClient {
      #stateRequestCount = 0;

      override responseFor(command: PiRpcCommandRequest): PiRpcResponse {
        if (command.type === "get_state") {
          this.#stateRequestCount += 1;
          const response = super.responseFor(command);
          if (this.#stateRequestCount === 1 || !response.success) {
            return response;
          }
          return {
            ...response,
            data: {
              model: { provider: "openai-codex", id: "gpt-5.6-sol" },
              thinkingLevel: "high",
              isStreaming: false,
              isCompacting: false,
              steeringMode: "all",
              followUpMode: "one-at-a-time",
              sessionFile: "/sessions/session-1.jsonl",
              sessionId: "session-1",
              pendingMessageCount: 1,
            },
          };
        }
        if (command.type === "clear_queue") {
          return {
            type: "response",
            command: command.type,
            success: true,
            data: { steering: ["queued"], followUp: [] },
          };
        }
        return super.responseFor(command);
      }
    }

    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new QueuedPiClient();
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async (_chatId, error) => {
          throw error;
        },
      },
    });

    expect(await manager.stop(1, 78)).toBeTrue();
    await manager.close();

    expect(
      client.requests.some((request) => request.type === "clear_queue"),
    ).toBeTrue();
    expect(
      client.requests.some((request) => request.type === "abort"),
    ).toBeFalse();
    expect(
      client.requests.some((request) => request.type === "new_session"),
    ).toBeFalse();
    expect(stateStore.snapshot().chats["1"]?.session?.id).toBe("session-1");
  });

  test("/new 中止当前运行并只切换当前 chat 的持久 session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    await stateStore.update((state) => {
      state.chats["2"] = {
        session: { id: "other-session", file: "/sessions/other.jsonl" },
        messageOrder: [],
        messages: {},
      };
    });
    const client = new FakePiClient();
    const resets: Array<{ chatId: number; replyTo: number }> = [];
    const logger = new RecordingLogger();
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      logger,
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async (chatId, replyTo) => {
          resets.push({ chatId, replyTo });
        },
        onError: async (_chatId, error) => {
          throw error;
        },
      },
    });

    await manager.submit(message(1, "before reset"));
    await waitFor(() => client.requests.some((item) => item.type === "prompt"));
    client.emit({ type: "agent_start" });
    const resetting = manager.newSession(1, 99);
    await waitFor(() => client.requests.some((item) => item.type === "abort"));
    client.emit({ type: "agent_settled" });
    await resetting;
    await manager.close();

    expect(client.requests.map((item) => item.type)).toEqual(
      expect.arrayContaining(["clear_queue", "abort", "new_session"]),
    );
    expect(stateStore.snapshot().chats["1"]?.session).toEqual({
      id: "session-2",
      file: "/sessions/session-2.jsonl",
      materialized: false,
    });
    expect(stateStore.snapshot().chats["2"]?.session?.id).toBe("other-session");
    expect(resets).toEqual([{ chatId: 1, replyTo: 99 }]);
    expect(logger.events()).toEqual(
      expect.arrayContaining([
        "pi_session_reset_started",
        "pi_abort_sent",
        "pi_abort_completed",
        "pi_session_reset_succeeded",
      ]),
    );
  });

  test("/new 只等待记忆 checkpoint，不等待后台提取", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const sessionFile = join(directory, "session-1.jsonl");
    await writeFile(
      sessionFile,
      '{"type":"session","id":"session-1","cwd":"/tmp"}\n{"type":"message","message":{"role":"user","content":"remember"}}\n',
    );
    let extractionStarted = false;
    const extractor: MemoryExtractionRunner = {
      async extract(_job, signal) {
        extractionStarted = true;
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });
        return [];
      },
    };
    const memoryStore = await MemoryStore.open({
      memoryDir: join(directory, "memory"),
      stateDir: join(directory, "memory-state"),
    });
    const memory = new MemoryCoordinator({ store: memoryStore, extractor });
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient(
      "session-1",
      sessionFile,
      false,
      join(directory, "session-2.jsonl"),
    );
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionCheckpoint: async (chatId, session) =>
          memory.checkpointSession({
            chatId,
            sessionId: session.id,
            sessionFile: session.file,
          }),
        onSessionReset: async () => undefined,
        onError: async (_chatId, error) => {
          throw error;
        },
      },
    });

    const resetCompleted = await Promise.race([
      manager.newSession(1, 99).then(() => true),
      Bun.sleep(100).then(() => false),
    ]);

    expect(resetCompleted).toBeTrue();
    await waitFor(() => extractionStarted);
    await memory.close();
    await manager.close();
  });

  test("/new 可以重置旧版本遗留的未落盘 session", async () => {
    class InitializingClient extends FakePiClient {
      override readonly sessionLaunchMode = "initialize" as const;
    }

    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    await stateStore.update((state) => {
      state.chats["1"] = {
        session: { id: "legacy-empty", file: join(directory, "missing.jsonl") },
        messageOrder: [],
        messages: {},
      };
    });
    const client = new InitializingClient(
      "temporary",
      join(directory, "temporary.jsonl"),
      false,
      join(directory, "session-2.jsonl"),
    );
    const launchRequests: Array<
      undefined | { file: string; missingPolicy: "error" | "initialize" }
    > = [];
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: {
        create: async (_chatId, session) => {
          launchRequests.push(session);
          if (session?.missingPolicy === "error") {
            throw new PiSessionFileMissingError(
              Object.assign(new Error("missing session"), { code: "ENOENT" }),
            );
          }
          return client;
        },
      },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async () => undefined,
      },
    });

    await expect(manager.restart(1)).rejects.toMatchObject({ code: "ENOENT" });
    await manager.newSession(1, 99);
    await manager.close();

    expect(launchRequests).toEqual([
      {
        file: join(directory, "missing.jsonl"),
        missingPolicy: "error",
      },
      {
        file: join(directory, "missing.jsonl"),
        missingPolicy: "initialize",
      },
    ]);
    expect(stateStore.snapshot().chats["1"]?.session).toEqual({
      id: "session-2",
      file: join(directory, "session-2.jsonl"),
      materialized: false,
    });
  });

  test("/new 会把并发中的严格恢复升级为缺失 session 初始化", async () => {
    class InitializingClient extends FakePiClient {
      override readonly sessionLaunchMode = "initialize" as const;
    }

    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const missingFile = join(directory, "missing.jsonl");
    await stateStore.update((state) => {
      state.chats["1"] = {
        session: { id: "legacy-empty", file: missingFile },
        messageOrder: [],
        messages: {},
      };
    });
    const client = new InitializingClient(
      "temporary",
      join(directory, "temporary.jsonl"),
      false,
      join(directory, "session-2.jsonl"),
    );
    let rejectStrict: ((error: Error) => void) | undefined;
    const strictRecovery = new Promise<PiRpcClientLike>((_resolve, reject) => {
      rejectStrict = reject;
    });
    const launchRequests: Array<
      undefined | { file: string; missingPolicy: "error" | "initialize" }
    > = [];
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: {
        create: async (_chatId, session) => {
          launchRequests.push(session);
          return launchRequests.length === 1 ? strictRecovery : client;
        },
      },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async () => undefined,
      },
    });

    const statusFailure = manager.status(1).catch((error: unknown) => error);
    await waitFor(() => launchRequests.length === 1);
    const resetting = manager.newSession(1, 99);
    await Promise.resolve();
    expect(launchRequests).toHaveLength(1);
    rejectStrict?.(
      new PiSessionFileMissingError(
        Object.assign(new Error("missing session"), { code: "ENOENT" }),
      ),
    );
    await expect(statusFailure).resolves.toMatchObject({ code: "ENOENT" });
    await resetting;
    await manager.close();

    expect(launchRequests).toEqual([
      { file: missingFile, missingPolicy: "error" },
      { file: missingFile, missingPolicy: "initialize" },
    ]);
    expect(stateStore.snapshot().chats["1"]?.session).toEqual({
      id: "session-2",
      file: join(directory, "session-2.jsonl"),
      materialized: false,
    });
  });

  test("并发 /restart 会阻止过期的 /new fallback 创建进程", async () => {
    class InitializingClient extends FakePiClient {
      override readonly sessionLaunchMode = "initialize" as const;
    }

    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const missingFile = join(directory, "missing.jsonl");
    await stateStore.update((state) => {
      state.chats["1"] = {
        session: { id: "legacy-empty", file: missingFile },
        messageOrder: [],
        messages: {},
      };
    });
    const firstClient = new InitializingClient(
      "temporary-1",
      join(directory, "temporary-1.jsonl"),
      false,
      join(directory, "session-2.jsonl"),
    );
    const secondClient = new InitializingClient(
      "temporary-2",
      join(directory, "temporary-2.jsonl"),
      false,
      join(directory, "session-3.jsonl"),
    );
    let rejectStrict: ((error: Error) => void) | undefined;
    const strictRecovery = new Promise<PiRpcClientLike>((_resolve, reject) => {
      rejectStrict = reject;
    });
    const launchRequests: Array<
      undefined | { file: string; missingPolicy: "error" | "initialize" }
    > = [];
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: {
        create: async (_chatId, session) => {
          launchRequests.push(session);
          if (launchRequests.length === 1) {
            return await strictRecovery;
          }
          return launchRequests.length === 2 ? firstClient : secondClient;
        },
      },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async () => undefined,
      },
    });

    const statusFailure = manager.status(1).catch((error: unknown) => error);
    await waitFor(() => launchRequests.length === 1);
    const resettingFailure = manager
      .newSession(1, 99)
      .catch((error: unknown) => error);
    const restartingFailure = manager
      .restart(1)
      .catch((error: unknown) => error);
    rejectStrict?.(
      new PiSessionFileMissingError(
        Object.assign(new Error("missing session"), { code: "ENOENT" }),
      ),
    );
    await Promise.all([statusFailure, resettingFailure, restartingFailure]);
    expect(launchRequests).toHaveLength(1);

    await manager.newSession(1, 100);
    expect(launchRequests).toHaveLength(2);
    firstClient.emitFatal(new Error("fatal"));
    await manager.newSession(1, 101);
    expect(launchRequests).toHaveLength(3);
    await manager.close();
  });

  test("并发恢复完成后的 /new 与服务关闭共享同一关闭任务", async () => {
    class DelayedCloseClient extends FakePiClient {
      closeCalls = 0;
      closeStarted = false;
      #releaseClose: (() => void) | undefined;
      readonly #closeGate = new Promise<void>((resolve) => {
        this.#releaseClose = resolve;
      });

      override async close(): Promise<void> {
        this.closeCalls += 1;
        this.closeStarted = true;
        await this.#closeGate;
        await super.close();
      }

      releaseClose(): void {
        this.#releaseClose?.();
      }
    }

    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    await stateStore.update((state) => {
      state.chats["1"] = {
        session: { id: "old", file: "/sessions/old.jsonl" },
        messageOrder: [],
        messages: {},
      };
    });
    const client = new DelayedCloseClient("old", "/sessions/old.jsonl");
    let resolveRecovery: ((client: PiRpcClientLike) => void) | undefined;
    const recovery = new Promise<PiRpcClientLike>((resolve) => {
      resolveRecovery = resolve;
    });
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => await recovery },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async () => undefined,
      },
    });

    const statusFailure = manager.status(1).catch((error: unknown) => error);
    const resettingFailure = manager
      .newSession(1, 99)
      .catch((error: unknown) => error);
    let closed = false;
    const closing = manager.close().then(() => {
      closed = true;
    });
    resolveRecovery?.(client);
    await waitFor(() => client.closeStarted);
    await Promise.resolve();

    expect(closed).toBeFalse();
    expect(client.closeCalls).toBe(1);
    client.releaseClose();
    await closing;
    await expect(statusFailure).resolves.toBeInstanceOf(Error);
    await expect(resettingFailure).resolves.toBeInstanceOf(Error);
    expect(client.closeCalls).toBe(1);
  });

  test("/new 被扩展取消时保留旧 session 并报告错误", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient(
      "session-1",
      "/sessions/session-1.jsonl",
      true,
    );
    const errors: string[] = [];
    const errorReplies: Array<number | undefined> = [];
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async (_chatId, error, replyToMessageId) => {
          errors.push(error.message);
          errorReplies.push(replyToMessageId);
        },
      },
    });

    await expect(manager.newSession(1, 99)).rejects.toThrow("取消");
    await manager.close();

    expect(errors).toEqual([]);
    expect(errorReplies).toEqual([]);
    expect(stateStore.snapshot().chats["1"]?.session?.id).toBe("session-1");
  });

  test("引用附件超限时仍把失败状态提交给 Pi", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient();
    const failures: Array<{ message: string; replyTo?: number }> = [];
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: {
        download: async () => {
          throw new TelegramDownloadError(
            "too_large",
            "reference file unavailable",
          );
        },
      },
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
    const input = message(77, "look at reply");
    input.reply = {
      messageId: 10,
      target: {
        messageId: 10,
        role: "user",
        sentAt: "2026-09-01T00:00:00Z",
        text: "attachment",
        attachments: [
          {
            kind: "document",
            fileId: "file",
            fileUniqueId: "unique",
            fileName: "missing.bin",
          },
        ],
      },
    };

    await manager.submit(input);
    await waitFor(() => client.requests.some((item) => item.type === "prompt"));
    await manager.close();

    expect(failures).toEqual([]);
    const prompt = client.requests.find((item) => item.type === "prompt");
    expect(prompt).toMatchObject({
      message: expect.stringContaining(
        'status="unavailable" reason="telegram_public_api_limit" limit="20971520"',
      ),
    });
  });

  test("连续入队时错误仍绑定到失败操作自己的消息 ID", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient();
    const originalRequest = client.request.bind(client);
    let failFirstPrompt = true;
    client.request = async (command) => {
      if (command.type === "prompt" && failFirstPrompt) {
        failFirstPrompt = false;
        throw new Error("prompt failed");
      }
      return originalRequest(command);
    };
    let releaseDownload: (() => void) | undefined;
    let downloadStarted = false;
    const downloadGate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const errorReplies: Array<number | undefined> = [];
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: {
        download: async (attachment) => {
          downloadStarted = true;
          await downloadGate;
          return { ...attachment, localPath: "/missing/reference.jpg" };
        },
      },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async (_chatId, _error, replyToMessageId) => {
          errorReplies.push(replyToMessageId);
        },
      },
    });
    const first = message(70, "first");
    first.reply = {
      messageId: 9,
      target: {
        messageId: 9,
        role: "user",
        sentAt: "2026-09-01T00:00:00Z",
        text: "file",
        attachments: [
          {
            kind: "photo",
            fileId: "file",
            fileUniqueId: "unique",
            width: 100,
            height: 100,
          },
        ],
      },
    };

    await manager.submit(first);
    await waitFor(() => downloadStarted);
    await manager.submit(message(71, "later message"));
    releaseDownload?.();
    await waitFor(() => errorReplies.length === 1);
    await manager.close();

    expect(errorReplies).toEqual([70]);
  });

  test("不同 chat 使用独立 Pi client 和 session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const clients = new Map([
      [1, new FakePiClient("session-1", "/sessions/1.jsonl")],
      [2, new FakePiClient("session-2", "/sessions/2.jsonl")],
    ]);
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: {
        create: async (chatId) => {
          const client = clients.get(chatId);
          if (!client) {
            throw new Error(`缺少 chat ${chatId} 的 fake client`);
          }
          return client;
        },
      },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async (_chatId, error) => {
          throw error;
        },
      },
    });

    await manager.submit(message(1, "chat one"));
    await manager.submit({ ...message(1, "chat two"), chatId: 2 });
    await waitFor(() =>
      [...clients.values()].every((client) =>
        client.requests.some((item) => item.type === "prompt"),
      ),
    );
    const statuses = await Promise.all([manager.status(1), manager.status(2)]);
    await manager.close();

    expect(statuses).toEqual([
      {
        sessionId: "session-1",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        thinkingLevel: "high",
        contextUsage: {
          tokens: 120_000,
          contextWindow: 200_000,
          percent: 60,
        },
      },
      {
        sessionId: "session-2",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        thinkingLevel: "high",
        contextUsage: {
          tokens: 120_000,
          contextWindow: 200_000,
          percent: 60,
        },
      },
    ]);
    expect(
      [...clients.values()].every(
        (client) =>
          client.requests.filter((item) => item.type === "get_session_stats")
            .length === 1,
      ),
    ).toBeTrue();
    expect(stateStore.snapshot().chats["1"]?.session?.id).toBe("session-1");
    expect(stateStore.snapshot().chats["2"]?.session?.id).toBe("session-2");
  });

  test("/status 检测到 session 快照不一致时重试", async () => {
    class ChangingStatsClient extends FakePiClient {
      statsRequests = 0;

      override responseFor(command: PiRpcCommandRequest): PiRpcResponse {
        if (command.type === "get_session_stats") {
          this.statsRequests += 1;
          const response = super.responseFor(command);
          if (this.statsRequests === 1 && response.success) {
            return {
              ...response,
              data: {
                sessionId: "other-session",
                contextUsage: {
                  tokens: 1,
                  contextWindow: 200_000,
                  percent: 0.0005,
                },
              },
            };
          }
          return response;
        }
        return super.responseFor(command);
      }
    }

    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new ChangingStatsClient();
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async (_chatId, error) => {
          throw error;
        },
      },
    });

    expect((await manager.status(1)).sessionId).toBe("session-1");
    expect(client.statsRequests).toBe(2);
    await manager.close();
  });

  test("/restart 关闭旧进程期间不会创建第二个同 session 进程", async () => {
    let releaseClose: (() => void) | undefined;
    let closeStarted: (() => void) | undefined;
    const closeStartedPromise = new Promise<void>((resolve) => {
      closeStarted = resolve;
    });
    class SlowCloseClient extends FakePiClient {
      override async close(): Promise<void> {
        this.closed = true;
        closeStarted?.();
        await new Promise<void>((resolve) => {
          releaseClose = resolve;
        });
      }
    }

    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const oldClient = new SlowCloseClient("session-1", "/sessions/1.jsonl");
    const replacement = new FakePiClient("session-1", "/sessions/1.jsonl");
    let createCount = 0;
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: {
        create: async () => {
          createCount += 1;
          return createCount === 1 ? oldClient : replacement;
        },
      },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async (_chatId, error) => {
          throw error;
        },
      },
    });

    await manager.status(1);
    const restarting = manager.restart(1);
    await closeStartedPromise;
    const submitting = manager.submit(message(83, "after restart"));
    await new Promise((resolve) => setTimeout(resolve, 2_100));

    expect(createCount).toBe(1);
    releaseClose?.();
    await Promise.all([restarting, submitting]);
    expect(createCount).toBe(2);
    await manager.close();
  });

  test("/new 后未落盘的空 session 可以通过 /restart 恢复", async () => {
    class InitializingClient extends FakePiClient {
      override readonly sessionLaunchMode = "initialize" as const;
    }

    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const pendingFile = join(directory, "session-2.jsonl");
    const replacementFile = join(directory, "session-3.jsonl");
    const oldClient = new FakePiClient(
      "session-1",
      join(directory, "session-1.jsonl"),
      false,
      pendingFile,
    );
    const replacement = new InitializingClient("session-3", replacementFile);
    const createCalls: Array<
      undefined | { file: string; missingPolicy: "error" | "initialize" }
    > = [];
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: {
        create: async (_chatId, session) => {
          createCalls.push(session);
          if (createCalls.length === 1) {
            return oldClient;
          }
          if (session?.missingPolicy !== "initialize") {
            throw new PiSessionFileMissingError(
              Object.assign(new Error("missing session"), { code: "ENOENT" }),
            );
          }
          return replacement;
        },
      },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async (_chatId, error) => {
          throw error;
        },
      },
    });

    await manager.status(1);
    await manager.newSession(1, 99);
    await manager.restart(1);
    const status = await manager.status(1);

    expect(createCalls).toEqual([
      undefined,
      {
        file: pendingFile,
        missingPolicy: "initialize",
      },
    ]);
    expect(status.sessionId).toBe("session-3");
    expect(stateStore.snapshot().chats["1"]?.session).toEqual({
      id: "session-3",
      file: replacementFile,
      materialized: false,
    });

    await writeFile(replacementFile, "session\n");
    replacement.emit({ type: "agent_settled" });
    await manager.close();
    expect(stateStore.snapshot().chats["1"]?.session?.materialized).toBeTrue();
  });

  test("/restart 只重启当前 chat 并恢复同一 session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const oldClient = new FakePiClient("session-1", "/sessions/1.jsonl");
    const replacement = new FakePiClient("session-1", "/sessions/1.jsonl");
    const otherClient = new FakePiClient("session-2", "/sessions/2.jsonl");
    const createCounts = new Map<number, number>();
    const finals: PiFinalResponse[] = [];
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: {
        create: async (chatId) => {
          const count = createCounts.get(chatId) ?? 0;
          createCounts.set(chatId, count + 1);
          if (chatId === 1) {
            return count === 0 ? oldClient : replacement;
          }
          return otherClient;
        },
      },
      downloader: { download: async (attachment) => attachment },
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

    await manager.submit(message(1, "chat one"));
    await manager.submit({ ...message(2, "chat two"), chatId: 2 });
    await waitFor(
      () =>
        oldClient.requests.some((request) => request.type === "prompt") &&
        otherClient.requests.some((request) => request.type === "prompt"),
    );
    oldClient.emit({ type: "agent_start" });

    await manager.restart(1);
    oldClient.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "late response" }],
        stopReason: "stop",
        timestamp: 1,
      },
    });
    oldClient.emit({ type: "agent_settled" });
    const restartedStatus = await manager.status(1);
    await manager.close();

    expect(oldClient.closed).toBeTrue();
    expect(createCounts).toEqual(
      new Map([
        [1, 2],
        [2, 1],
      ]),
    );
    expect(restartedStatus.sessionId).toBe("session-1");
    expect(stateStore.snapshot().chats["1"]?.session?.id).toBe("session-1");
    expect(stateStore.snapshot().chats["2"]?.session?.id).toBe("session-2");
    expect(finals).toEqual([]);
  });

  test("停止信号到达后、agent 排空前的 Pi fatal 不会通知用户", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient();
    const logger = new RecordingLogger();
    const errors: string[] = [];
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      logger,
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async (_chatId, error) => {
          errors.push(error.message);
        },
      },
    });
    let releaseIngress: (() => void) | undefined;
    const ingressClosed = new Promise<void>((resolve) => {
      releaseIngress = resolve;
    });
    const lifecycle = new BridgeLifecycle({
      beginShutdown: () => manager.beginShutdown(),
      registerCommands: async () => undefined,
      startPolling: async () => undefined,
      stopPolling: async () => undefined,
      closeIngress: async () => await ingressClosed,
      closeAgents: async () => await manager.close(),
      closeOutbound: async () => undefined,
      closeDrafts: async () => undefined,
      closeActivity: async () => undefined,
    });

    await manager.submit(message(1, "active session"));
    await waitFor(() => client.requests.some((item) => item.type === "prompt"));
    const stopping = lifecycle.stop();
    client.emitFatal(new Error("Pi RPC 子进程异常退出，状态码 130"));
    await Promise.resolve();
    releaseIngress?.();
    await stopping;

    expect(errors).toEqual([]);
    expect(logger.events()).not.toContain("pi_agent_fatal");
  });

  test("Pi 子进程恢复创建失败时记录明确失败事件", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient();
    const logger = new RecordingLogger();
    const errors: string[] = [];
    let createCount = 0;
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: {
        create: async () => {
          createCount += 1;
          if (createCount === 1) {
            return client;
          }
          throw new Error("private recovery creation details");
        },
      },
      downloader: { download: async (attachment) => attachment },
      logger,
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async (_chatId, error) => {
          errors.push(error.message);
        },
      },
    });

    await manager.submit(message(1, "first"));
    await waitFor(() => client.requests.some((item) => item.type === "prompt"));
    client.emitFatal(new Error("Pi exited"));
    await waitFor(() => errors.length === 1);
    await expect(manager.submit(message(2, "retry"))).rejects.toThrow(
      "private recovery creation details",
    );
    await manager.close();

    expect(logger.events()).toEqual(
      expect.arrayContaining([
        "pi_agent_recovery_started",
        "pi_agent_recovery_failed",
      ]),
    );
    expect(JSON.stringify(logger.entries)).not.toContain(
      "private recovery creation details",
    );
  });

  test("初始化失败且子进程关闭失败时不会创建重叠进程", async () => {
    class UncloseableClient extends FakePiClient {
      override async close(): Promise<void> {
        throw new Error("kill failed");
      }
    }

    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    await stateStore.update((state) => {
      state.chats["1"] = {
        session: { id: "expected", file: "/sessions/expected.jsonl" },
        messageOrder: [],
        messages: {},
      };
    });
    let createCount = 0;
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: {
        create: async () => {
          createCount += 1;
          return new UncloseableClient("wrong", "/sessions/wrong.jsonl");
        },
      },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async () => undefined,
      },
    });

    await expect(manager.status(1)).rejects.toThrow(
      "初始化失败后无法确认子进程已关闭",
    );
    await expect(manager.status(1)).rejects.toThrow(
      "初始化失败后无法确认子进程已关闭",
    );
    expect(createCount).toBe(1);
    await expect(manager.close()).rejects.toThrow(
      "Pi agent manager 关闭不完整",
    );
  });

  test("Pi 子进程 fatal 后移除旧 agent，下一条消息会重新创建", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const clients = [new FakePiClient(), new FakePiClient()];
    let createCount = 0;
    const errors: string[] = [];
    const logger = new RecordingLogger();
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: {
        create: async () => {
          const client = clients[createCount];
          createCount += 1;
          if (!client) {
            throw new Error("没有 fake client");
          }
          return client;
        },
      },
      downloader: { download: async (attachment) => attachment },
      logger,
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async (_chatId, error) => {
          errors.push(error.message);
        },
      },
    });

    await manager.submit(message(1, "first"));
    await waitFor(
      () =>
        clients[0]?.requests.some((item) => item.type === "prompt") === true,
    );
    clients[0]?.emitFatal(new Error("Pi exited"));
    await waitFor(() => errors.length === 1);
    await manager.submit(message(2, "second"));
    await waitFor(
      () =>
        clients[1]?.requests.some((item) => item.type === "prompt") === true,
    );
    await manager.close();

    expect(createCount).toBe(2);
    expect(errors).toEqual(["Pi exited"]);
    expect(
      logger.events().filter((event) => event === "pi_agent_create_started"),
    ).toHaveLength(2);
    expect(logger.events()).toEqual(
      expect.arrayContaining([
        "pi_agent_fatal",
        "pi_agent_recovery_started",
        "pi_agent_recovered",
      ]),
    );
  });

  test("服务关闭会排空已经接收但尚未提交的消息", async () => {
    class DelayedSubmitClient extends FakePiClient {
      #stateRequests = 0;
      #releaseSubmit: (() => void) | undefined;

      override async request(
        command: PiRpcCommandRequest,
      ): Promise<PiRpcResponse> {
        if (command.type === "get_state") {
          this.#stateRequests += 1;
          if (this.#stateRequests === 2) {
            this.requests.push(command);
            await new Promise<void>((resolve) => {
              this.#releaseSubmit = resolve;
            });
            return this.responseFor(command);
          }
        }
        return await super.request(command);
      }

      releaseSubmit(): void {
        this.#releaseSubmit?.();
      }
    }

    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new DelayedSubmitClient();
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async () => undefined,
      },
    });

    await manager.submit(message(98, "queued"));
    await waitFor(
      () =>
        client.requests.filter((item) => item.type === "get_state").length ===
        2,
    );
    const closing = manager.close();
    const closedEarly = await Promise.race([
      closing.then(() => true),
      Bun.sleep(10).then(() => false),
    ]);
    expect(closedEarly).toBeFalse();

    client.releaseSubmit();
    await closing;
    expect(client.requests.some((item) => item.type === "prompt")).toBeTrue();
    expect(stateStore.snapshot().chats["1"]?.messages["98"]?.text).toBe(
      "queued",
    );
  });

  test("服务关闭会等待已经开始的最终回复发送完成", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient();
    let finalStarted = false;
    let finalSignal: PiFinalResponse["signal"] | undefined;
    let releaseFinal: (() => void) | undefined;
    const finalPending = new Promise<void>((resolve) => {
      releaseFinal = resolve;
    });
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async (response) => {
          finalStarted = true;
          finalSignal = response.signal;
          await finalPending;
        },
        onSessionReset: async () => undefined,
        onError: async () => undefined,
      },
    });

    await manager.submit(message(93, "reply"));
    await waitFor(() => client.requests.some((item) => item.type === "prompt"));
    client.emit({ type: "agent_start" });
    client.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "final" }],
        stopReason: "stop",
        timestamp: 1,
      },
    });
    client.emit({ type: "agent_settled" });
    await waitFor(() => finalStarted);

    const closing = manager.close();
    const closedEarly = await Promise.race([
      closing.then(() => true),
      Bun.sleep(10).then(() => false),
    ]);
    expect(closedEarly).toBeFalse();
    expect(finalSignal?.aborted).toBeFalse();

    releaseFinal?.();
    await closing;
    expect(client.closed).toBeTrue();
  });

  test("服务关闭会等待已经开始的 Telegram 工具完成", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient();
    let uploadStarted = false;
    let releaseUpload: (() => void) | undefined;
    const uploadPending = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onTelegramOutbound: async () => {
          uploadStarted = true;
          await uploadPending;
          return {
            version: 1,
            status: "sent",
            kind: "document",
            messageId: 501,
            indexed: true,
            fileName: "report.pdf",
            size: 12,
            mimeType: "application/pdf",
          };
        },
        onSessionReset: async () => undefined,
        onError: async () => undefined,
      },
    });

    await manager.submit(message(94, "send"));
    await waitFor(() => client.requests.some((item) => item.type === "prompt"));
    client.emit({ type: "agent_start" });
    client.emit({
      type: "tool_execution_start",
      toolCallId: "graceful-upload-tool",
      toolName: "telegram_send_document",
      args: { path: "report.pdf" },
    });
    client.emit({
      type: "extension_ui_request",
      id: "ui-graceful-upload",
      method: "input",
      title: "amadeus.telegram.v1",
      placeholder: "graceful-upload-tool",
      payload: {},
    });
    await waitFor(() => uploadStarted);

    const closing = manager.close();
    const closedEarly = await Promise.race([
      closing.then(() => true),
      Bun.sleep(10).then(() => false),
    ]);
    expect(closedEarly).toBeFalse();

    releaseUpload?.();
    await closing;
    expect(client.closed).toBeTrue();
    expect(client.notifications).toHaveLength(1);
  });

  test("优雅关闭在排空已接受工作前保留 Memory 事件订阅", async () => {
    class DelayedPromptClient extends FakePiClient {
      #resolvePrompt: ((response: PiRpcResponse) => void) | undefined;

      override dispatch(command: PiRpcCommandRequest): PiRpcRequestHandle {
        if (command.type !== "prompt") {
          return super.dispatch(command);
        }
        this.requests.push(command);
        return {
          sent: Promise.resolve(),
          response: new Promise((resolve) => {
            this.#resolvePrompt = resolve;
          }),
        };
      }

      releasePrompt(): void {
        const command = this.requests
          .filter((item) => item.type === "prompt")
          .at(-1);
        if (!command) {
          throw new Error("缺少 prompt 请求");
        }
        this.#resolvePrompt?.(this.responseFor(command));
      }
    }

    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new DelayedPromptClient();
    let memoryStarted = false;
    let releaseMemory: (() => void) | undefined;
    const memoryPending = new Promise<void>((resolve) => {
      releaseMemory = resolve;
    });
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onMemoryRequest: async (request) => {
          if (request.kind !== "tool") {
            return { version: 1, status: "unavailable", code: "not_ready" };
          }
          memoryStarted = true;
          await memoryPending;
          return {
            version: 1,
            status: "completed",
            receiptId: `tool:${request.toolCallId}`,
            content: "Stored.",
          };
        },
        onSessionReset: async () => undefined,
        onError: async () => undefined,
      },
    });

    await manager.submit(message(941, "remember"));
    await waitFor(() => client.requests.some((item) => item.type === "prompt"));
    const closing = manager.close();
    client.emit({ type: "agent_start" });
    client.emit({
      type: "tool_execution_start",
      toolCallId: "memory-during-close",
      toolName: "memory_write",
      args: { target: "long_term", content: "Uses Bun" },
    });
    client.emit({
      type: "extension_ui_request",
      id: "ui-memory-during-close",
      method: "input",
      title: MEMORY_PROTOCOL_TITLE,
      placeholder: encodeMemoryUiRequest({
        version: 1,
        type: "tool_execute",
        toolCallId: "memory-during-close",
      }),
      payload: {},
    });

    await waitFor(() => memoryStarted);
    const closedEarly = await Promise.race([
      closing.then(() => true),
      Bun.sleep(10).then(() => false),
    ]);
    expect(closedEarly).toBeFalse();

    releaseMemory?.();
    await waitFor(() => client.notifications.length === 1);
    client.releasePrompt();
    await closing;
    expect(client.closed).toBeTrue();
  });

  test("一个 agent 关闭失败时仍等待其他 agent 完成关闭", async () => {
    class FailingCloseClient extends FakePiClient {
      override async close(): Promise<void> {
        this.closed = true;
        throw new Error("close failed");
      }
    }
    class DelayedCloseClient extends FakePiClient {
      closeStarted = false;
      #releaseClose: (() => void) | undefined;

      override async close(): Promise<void> {
        this.closeStarted = true;
        await new Promise<void>((resolve) => {
          this.#releaseClose = resolve;
        });
        this.closed = true;
      }

      releaseClose(): void {
        this.#releaseClose?.();
      }
    }

    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const first = new FailingCloseClient("session-1", "/sessions/one.jsonl");
    const second = new DelayedCloseClient("session-2", "/sessions/two.jsonl");
    const clients = [first, second];
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: {
        create: async () => {
          const client = clients.shift();
          if (!client) {
            throw new Error("没有 fake client");
          }
          return client;
        },
      },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async () => undefined,
      },
    });

    await manager.submit(message(96, "one"));
    await manager.submit({ ...message(97, "two"), chatId: 2 });
    const closing = manager.close();
    void closing.catch(() => undefined);
    await waitFor(() => second.closeStarted);
    const closedEarly = await Promise.race([
      closing.then(
        () => true,
        () => true,
      ),
      Bun.sleep(10).then(() => false),
    ]);
    expect(closedEarly).toBeFalse();

    second.releaseClose();
    await expect(closing).rejects.toThrow("Pi agent manager 关闭不完整");
    expect(first.closed).toBeTrue();
    expect(second.closed).toBeTrue();
  });

  test("Pi fatal 会中止正在上传的 Telegram 文件", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient();
    let uploadStarted = false;
    let uploadAborted = false;
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onTelegramOutbound: async (request) => {
          uploadStarted = true;
          await new Promise<void>((resolve) => {
            request.signal.addEventListener("abort", () => {
              uploadAborted = true;
              resolve();
            });
          });
          return {
            version: 1,
            status: "unknown",
            code: "telegram_delivery_unknown",
            message: "The Telegram delivery outcome cannot be confirmed",
          };
        },
        onSessionReset: async () => undefined,
        onError: async () => undefined,
      },
    });

    await manager.submit(message(93, "send"));
    await waitFor(() => client.requests.some((item) => item.type === "prompt"));
    client.emit({ type: "agent_start" });
    client.emit({
      type: "tool_execution_start",
      toolCallId: "fatal-upload-tool",
      toolName: "telegram_send_document",
      args: { path: "report.pdf" },
    });
    client.emit({
      type: "extension_ui_request",
      id: "ui-fatal-upload",
      method: "input",
      title: "amadeus.telegram.v1",
      placeholder: "fatal-upload-tool",
      payload: {},
    });
    await waitFor(() => uploadStarted);
    client.emitFatal(new Error("rpc exited"));
    await waitFor(() => uploadAborted && client.notifications.length === 1);
    await manager.close();

    expect(uploadAborted).toBeTrue();
  });

  test("相同 toolCallId 在不同 chat 中保持隔离", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const clients = new Map<number, FakePiClient>();
    const outbound: Array<{
      chatId: number;
      replyToMessageId: number;
      sessionId: string;
    }> = [];
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: {
        create: async (chatId) => {
          const client = new FakePiClient(`session-${chatId}`);
          clients.set(chatId, client);
          return client;
        },
      },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onTelegramOutbound: async (request) => {
          outbound.push({
            chatId: request.chatId,
            replyToMessageId: request.replyToMessageId,
            sessionId: request.sessionId,
          });
          return {
            version: 1,
            status: "sent",
            kind: request.kind,
            messageId: 1_000 + request.chatId,
            indexed: true,
            fileName: "report.pdf",
            size: 10,
            mimeType: "application/pdf",
          };
        },
        onSessionReset: async () => undefined,
        onError: async () => undefined,
      },
    });

    await manager.submit(message(95, "chat one"));
    await manager.submit({
      ...message(195, "chat two"),
      updateId: 195,
      chatId: 2,
      sender: { id: 2, displayName: "User 2" },
    });
    await waitFor(
      () =>
        clients.size === 2 &&
        [...clients.values()].every((client) =>
          client.requests.some((item) => item.type === "prompt"),
        ),
    );

    for (const [chatId, client] of clients) {
      client.emit({ type: "agent_start" });
      client.emit({
        type: "tool_execution_start",
        toolCallId: "shared-tool-id",
        toolName: "telegram_send_document",
        args: { path: `report-${chatId}.pdf` },
      });
      client.emit({
        type: "extension_ui_request",
        id: `ui-${chatId}`,
        method: "input",
        title: "amadeus.telegram.v1",
        placeholder: "shared-tool-id",
        payload: {},
      });
    }
    await waitFor(() =>
      [...clients.values()].every(
        (client) => client.notifications.length === 1,
      ),
    );
    await manager.close();

    expect(outbound).toHaveLength(2);
    expect(outbound).toEqual(
      expect.arrayContaining([
        { chatId: 1, replyToMessageId: 95, sessionId: "session-1" },
        { chatId: 2, replyToMessageId: 195, sessionId: "session-2" },
      ]),
    );
  });

  test("Memory UI 请求在未知交互取消前由父进程处理", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient();
    const requestKinds: string[] = [];
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onMemoryRequest: async (request) => {
          requestKinds.push(request.kind);
          return request.kind === "snapshot"
            ? {
                version: 1,
                status: "ready",
                revision: 4,
                content: "Known memory",
              }
            : {
                version: 1,
                status: "completed",
                receiptId: `tool:${request.toolCallId}`,
                content: "Stored.",
              };
        },
        onSessionReset: async () => undefined,
        onError: async (_chatId, error) => {
          throw error;
        },
      },
    });

    await manager.submit(message(80, "remember this"));
    await waitFor(() => client.requests.some((item) => item.type === "prompt"));
    client.emit({ type: "agent_start" });
    client.emit({
      type: "extension_ui_request",
      id: "ui-memory-snapshot",
      method: "input",
      title: MEMORY_PROTOCOL_TITLE,
      placeholder: encodeMemoryUiRequest({
        version: 1,
        type: "snapshot_get",
      }),
      payload: {},
    });
    client.emit({
      type: "tool_execution_start",
      toolCallId: "memory-tool-1",
      toolName: "memory_write",
      args: { target: "long_term", content: "Uses Bun" },
    });
    client.emit({
      type: "extension_ui_request",
      id: "ui-memory-tool",
      method: "input",
      title: MEMORY_PROTOCOL_TITLE,
      placeholder: encodeMemoryUiRequest({
        version: 1,
        type: "tool_execute",
        toolCallId: "memory-tool-1",
      }),
      payload: {},
    });

    await waitFor(() => client.notifications.length === 2);
    await manager.close();

    expect(requestKinds).toEqual(["snapshot", "tool"]);
    expect(
      client.notifications.every(
        (notification) => notification.type === "extension_ui_response",
      ),
    ).toBeTrue();
    expect(
      client.notifications.map((notification) =>
        "value" in notification ? JSON.parse(notification.value).status : null,
      ),
    ).toEqual(["ready", "completed"]);
  });

  test("同一 assistant turn 的多个 memory_read 空 date 调用都能关联", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient();
    const targets: string[] = [];
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onMemoryRequest: async (request) => {
          if (request.kind !== "tool") {
            return { version: 1, status: "unavailable", code: "test" };
          }
          targets.push(request.args.toolName);
          if (request.args.toolName === "memory_read") {
            expect(request.args).not.toHaveProperty("date");
          }
          return {
            version: 1,
            status: "completed",
            receiptId: `tool:${request.toolCallId}`,
            content: "Read.",
          };
        },
        onSessionReset: async () => undefined,
        onError: async (_chatId, error) => {
          throw error;
        },
      },
    });

    await manager.submit(message(801, "show memory"));
    await waitFor(() => client.requests.some((item) => item.type === "prompt"));
    const eventFixture = await readFile(
      join(
        import.meta.dir,
        "..",
        "fixtures",
        "memory-tools",
        "same-turn.jsonl",
      ),
      "utf8",
    );
    for (const line of eventFixture.trimEnd().split("\n")) {
      const event = parsePiRpcOutput(line);
      if (event.type === "response") {
        throw new Error("事件 fixture 不得包含 RPC response");
      }
      client.emit(event);
    }

    await waitFor(() => client.notifications.length === 2);
    await manager.close();

    expect(targets).toEqual(["memory_read", "memory_read"]);
    expect(
      client.notifications.map((notification) =>
        "value" in notification ? JSON.parse(notification.value).status : null,
      ),
    ).toEqual(["completed", "completed"]);
  });

  test("合法 Telegram 工具 UI 请求会调用父进程并返回结果", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient();
    const outbound: Array<{
      chatId: number;
      replyToMessageId: number;
      toolCallId: string;
      path: string;
    }> = [];
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onTelegramOutbound: async (request) => {
          outbound.push({
            chatId: request.chatId,
            replyToMessageId: request.replyToMessageId,
            toolCallId: request.toolCallId,
            path: request.args.path,
          });
          return {
            version: 1,
            status: "sent",
            kind: request.kind,
            messageId: 901,
            indexed: true,
            fileName: "report.pdf",
            size: 12,
            mimeType: "application/pdf",
          };
        },
        onSessionReset: async () => undefined,
        onError: async (_chatId, error) => {
          throw error;
        },
      },
    });

    await manager.submit(message(81, "send report"));
    await waitFor(() => client.requests.some((item) => item.type === "prompt"));
    client.emit({ type: "agent_start" });
    client.emit({
      type: "tool_execution_start",
      toolCallId: "telegram-tool-1",
      toolName: "telegram_send_document",
      args: { path: "report.pdf", caption: "Report" },
    });
    client.emit({
      type: "extension_ui_request",
      id: "ui-telegram-1",
      method: "input",
      title: "amadeus.telegram.v1",
      placeholder: "telegram-tool-1",
      payload: {},
    });

    await waitFor(() => client.notifications.length === 1);
    await manager.close();

    expect(outbound).toEqual([
      {
        chatId: 1,
        replyToMessageId: 81,
        toolCallId: "telegram-tool-1",
        path: "report.pdf",
      },
    ]);
    const response = client.notifications[0];
    expect(response).toMatchObject({
      type: "extension_ui_response",
      id: "ui-telegram-1",
    });
    if (!response || !("value" in response)) {
      throw new Error("预期 Telegram 工具 value 响应");
    }
    expect(JSON.parse(response.value)).toMatchObject({
      status: "sent",
      kind: "document",
      messageId: 901,
    });
  });

  test("无效 Telegram 工具参数和重复 UI 请求不会发送", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient();
    let sendCount = 0;
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onTelegramOutbound: async () => {
          sendCount += 1;
          throw new Error("不应调用");
        },
        onSessionReset: async () => undefined,
        onError: async () => undefined,
      },
    });

    await manager.submit(message(82, "send secret"));
    await waitFor(() => client.requests.some((item) => item.type === "prompt"));
    client.emit({ type: "agent_start" });
    client.emit({
      type: "tool_execution_start",
      toolCallId: "telegram-tool-invalid",
      toolName: "telegram_send_photo",
      args: { path: "photo.jpg", chatId: 999 },
    });
    const event = {
      type: "extension_ui_request" as const,
      id: "ui-invalid",
      method: "input",
      title: "amadeus.telegram.v1",
      placeholder: "telegram-tool-invalid",
      payload: {},
    };
    client.emit(event);
    await waitFor(() => client.notifications.length === 1);
    client.emit({ ...event, id: "ui-duplicate" });
    await waitFor(() => client.notifications.length === 2);
    await manager.close();

    expect(sendCount).toBe(0);
    const first = client.notifications[0];
    if (!first || !("value" in first)) {
      throw new Error("预期参数拒绝结果");
    }
    expect(JSON.parse(first.value)).toMatchObject({
      status: "rejected",
      code: "invalid_arguments",
    });
    expect(client.notifications[1]).toEqual({
      type: "extension_ui_response",
      id: "ui-duplicate",
      cancelled: true,
    });
  });

  test("Pi entry 查询失败在发送前返回 rejected 而不是 unknown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    class FailingEntriesClient extends FakePiClient {
      override responseFor(command: PiRpcCommandRequest): PiRpcResponse {
        if (command.type === "get_entries") {
          return {
            type: "response",
            command: command.type,
            success: false,
            error: "entries unavailable",
          };
        }
        return super.responseFor(command);
      }
    }
    const client = new FailingEntriesClient();
    let sendCount = 0;
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onTelegramOutbound: async () => {
          sendCount += 1;
          throw new Error("不应发送");
        },
        onSessionReset: async () => undefined,
        onError: async () => undefined,
      },
    });

    await manager.submit(message(91, "send"));
    await waitFor(() => client.requests.some((item) => item.type === "prompt"));
    client.emit({ type: "agent_start" });
    client.emit({
      type: "tool_execution_start",
      toolCallId: "missing-entry-tool",
      toolName: "telegram_send_document",
      args: { path: "report.pdf" },
    });
    client.emit({
      type: "extension_ui_request",
      id: "ui-missing-entry",
      method: "input",
      title: "amadeus.telegram.v1",
      placeholder: "missing-entry-tool",
      payload: {},
    });
    await waitFor(() => client.notifications.length === 1);
    await manager.close();

    expect(sendCount).toBe(0);
    const response = client.notifications[0];
    if (!response || !("value" in response)) {
      throw new Error("预期 Pi context rejected 结果");
    }
    expect(JSON.parse(response.value)).toMatchObject({
      status: "rejected",
      code: "pi_context_unavailable",
    });
    expect(
      stateStore.snapshot().chats["1"]?.outboundToolCallOrder,
    ).toBeUndefined();
  });

  test("同一 session 的重复 toolCallId 持久去重", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient();
    let sendCount = 0;
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onTelegramOutbound: async (request) => {
          sendCount += 1;
          return {
            version: 1,
            status: "sent",
            kind: request.kind,
            messageId: 910,
            indexed: true,
            fileName: "report.pdf",
            size: 10,
            mimeType: "application/pdf",
          };
        },
        onSessionReset: async () => undefined,
        onError: async () => undefined,
      },
    });

    await manager.submit(message(84, "send"));
    await waitFor(() => client.requests.some((item) => item.type === "prompt"));
    client.emit({ type: "agent_start" });
    const start = {
      type: "tool_execution_start" as const,
      toolCallId: "persistent-tool-id",
      toolName: "telegram_send_document",
      args: { path: "report.pdf" },
    };
    client.emit(start);
    client.emit({
      type: "extension_ui_request",
      id: "ui-first",
      method: "input",
      title: "amadeus.telegram.v1",
      placeholder: "persistent-tool-id",
      payload: {},
    });
    await waitFor(() => client.notifications.length === 1);
    client.emit({
      type: "tool_execution_end",
      toolCallId: "persistent-tool-id",
      toolName: "telegram_send_document",
      result: {},
      isError: false,
    });
    client.emit(start);
    client.emit({
      type: "extension_ui_request",
      id: "ui-replay",
      method: "input",
      title: "amadeus.telegram.v1",
      placeholder: "persistent-tool-id",
      payload: {},
    });
    await waitFor(() => client.notifications.length === 2);
    await manager.close();

    expect(sendCount).toBe(1);
    const replay = client.notifications[1];
    if (!replay || !("value" in replay)) {
      throw new Error("预期重放拒绝结果");
    }
    expect(JSON.parse(replay.value)).toMatchObject({
      status: "rejected",
      code: "duplicate_tool_call",
    });
    expect(
      stateStore.snapshot().chats["1"]?.outboundToolCallOrder,
    ).toHaveLength(1);
  });

  test("新 revision 会使上传前的旧 Telegram 工具调用失效", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient();
    let sendCount = 0;
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onTelegramOutbound: async () => {
          sendCount += 1;
          throw new Error("旧 revision 不应发送");
        },
        onSessionReset: async () => undefined,
        onError: async () => undefined,
      },
    });

    await manager.submit(message(85, "send old"));
    await waitFor(() => client.requests.some((item) => item.type === "prompt"));
    client.emit({ type: "agent_start" });
    client.emit({
      type: "tool_execution_start",
      toolCallId: "stale-tool",
      toolName: "telegram_send_photo",
      args: { path: "photo.png" },
    });
    await manager.submit(message(86, "new request"));
    client.emit({
      type: "extension_ui_request",
      id: "ui-stale",
      method: "input",
      title: "amadeus.telegram.v1",
      placeholder: "stale-tool",
      payload: {},
    });
    await waitFor(() => client.notifications.length === 1);
    client.emit({ type: "agent_settled" });
    await manager.close();

    expect(sendCount).toBe(0);
    const response = client.notifications[0];
    if (!response || !("value" in response)) {
      throw new Error("预期旧 revision 拒绝结果");
    }
    expect(JSON.parse(response.value)).toMatchObject({
      status: "rejected",
      code: "stale_revision",
    });
  });

  test("新 revision 会通过 signal 中止已开始的 Telegram 上传", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient();
    let uploadStarted = false;
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onTelegramOutbound: async (request) => {
          uploadStarted = true;
          await new Promise<void>((resolve) => {
            if (request.signal.aborted) {
              resolve();
              return;
            }
            request.signal.addEventListener("abort", () => resolve());
          });
          return {
            version: 1,
            status: "unknown",
            code: "telegram_delivery_unknown",
            message: "The Telegram delivery outcome cannot be confirmed",
          };
        },
        onSessionReset: async () => undefined,
        onError: async () => undefined,
      },
    });

    await manager.submit(message(89, "send now"));
    await waitFor(() => client.requests.some((item) => item.type === "prompt"));
    client.emit({ type: "agent_start" });
    client.emit({
      type: "tool_execution_start",
      toolCallId: "active-upload-tool",
      toolName: "telegram_send_document",
      args: { path: "report.pdf" },
    });
    client.emit({
      type: "extension_ui_request",
      id: "ui-active-upload",
      method: "input",
      title: "amadeus.telegram.v1",
      placeholder: "active-upload-tool",
      payload: {},
    });
    await waitFor(() => uploadStarted);
    await manager.submit(message(90, "replace request"));
    await waitFor(() => client.notifications.length === 1);
    client.emit({ type: "agent_settled" });
    await manager.close();

    const response = client.notifications[0];
    if (!response || !("value" in response)) {
      throw new Error("预期在途上传 unknown 结果");
    }
    expect(JSON.parse(response.value)).toMatchObject({ status: "unknown" });
  });

  test("/new 会使旧 session 的待发送 Telegram 工具失效", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient();
    let sendCount = 0;
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onTelegramOutbound: async (request) => {
          sendCount += 1;
          return {
            version: 1,
            status: "sent",
            kind: request.kind,
            messageId: 920,
            indexed: true,
            fileName: "new.pdf",
            size: 10,
            mimeType: "application/pdf",
          };
        },
        onSessionReset: async () => undefined,
        onError: async () => undefined,
      },
    });

    await manager.submit(message(87, "send before new"));
    await waitFor(() => client.requests.some((item) => item.type === "prompt"));
    client.emit({ type: "agent_start" });
    client.emit({
      type: "tool_execution_start",
      toolCallId: "old-session-tool",
      toolName: "telegram_send_document",
      args: { path: "old.pdf" },
    });
    const resetting = manager.newSession(1, 88);
    client.emit({
      type: "extension_ui_request",
      id: "ui-old-session",
      method: "input",
      title: "amadeus.telegram.v1",
      placeholder: "old-session-tool",
      payload: {},
    });
    await waitFor(() => client.notifications.length === 1);
    await waitFor(() => client.requests.some((item) => item.type === "abort"));
    client.emit({ type: "agent_settled" });
    await resetting;

    expect(sendCount).toBe(0);
    await manager.submit(message(92, "send after new"));
    await waitFor(
      () =>
        client.requests.filter((item) => item.type === "prompt").length === 2,
    );
    client.emit({ type: "agent_start" });
    client.emit({
      type: "tool_execution_start",
      toolCallId: "old-session-tool",
      toolName: "telegram_send_document",
      args: { path: "new.pdf" },
    });
    client.emit({
      type: "extension_ui_request",
      id: "ui-new-session",
      method: "input",
      title: "amadeus.telegram.v1",
      placeholder: "old-session-tool",
      payload: {},
    });
    await waitFor(() => client.notifications.length === 2);
    await manager.close();

    expect(sendCount).toBe(1);
    const response = client.notifications[0];
    if (!response || !("value" in response)) {
      throw new Error("预期旧 session 拒绝结果");
    }
    expect(JSON.parse(response.value)).toMatchObject({
      status: "rejected",
      code: "stale_revision",
    });
    const newSessionResponse = client.notifications[1];
    if (!newSessionResponse || !("value" in newSessionResponse)) {
      throw new Error("预期新 session 发送结果");
    }
    expect(JSON.parse(newSessionResponse.value)).toMatchObject({
      status: "sent",
      messageId: 920,
    });
  });

  test("未知 extension UI 请求继续被取消", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FakePiClient();
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async () => undefined,
      },
    });

    await manager.submit(message(83, "start"));
    await waitFor(() => client.requests.some((item) => item.type === "prompt"));
    client.emit({
      type: "extension_ui_request",
      id: "ui-other",
      method: "input",
      title: "another.extension",
      placeholder: "private",
      payload: {},
    });
    await waitFor(() => client.notifications.length === 1);
    await manager.close();

    expect(client.notifications).toEqual([
      {
        type: "extension_ui_response",
        id: "ui-other",
        cancelled: true,
      },
    ]);
  });

  test("后台 UI 取消和 fatal 错误回调拒绝不会形成未处理 rejection", async () => {
    class FailingNotifyClient extends FakePiClient {
      override async notify(): Promise<void> {
        throw new Error("notify failed");
      }
    }

    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const client = new FailingNotifyClient();
    const logger = new RecordingLogger();
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      logger,
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async () => {
          throw new Error("error callback failed");
        },
      },
    });

    await manager.submit(message(95, "start"));
    await waitFor(() => client.requests.some((item) => item.type === "prompt"));
    client.emit({
      type: "extension_ui_request",
      id: "ui-failing-cancel",
      method: "input",
      title: "another.extension",
      placeholder: "private",
      payload: {},
    });
    client.emitFatal(new Error("rpc failed"));
    await Bun.sleep(10);
    await manager.close();

    expect(logger.events()).toContain("pi_agent_fatal");
  });

  test("服务重启时把持久 session 文件交给新 Pi 子进程", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    await stateStore.update((state) => {
      state.chats["1"] = {
        session: { id: "old", file: "/sessions/old.jsonl" },
        messageOrder: [],
        messages: {},
      };
    });
    const client = new FakePiClient("old", "/sessions/old.jsonl");
    let restoredSession:
      { file: string; missingPolicy: "error" | "initialize" } | undefined;
    const logger = new RecordingLogger();
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: {
        create: async (_chatId, session) => {
          restoredSession = session;
          return client;
        },
      },
      downloader: { download: async (attachment) => attachment },
      logger,
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async () => undefined,
      },
    });

    await manager.submit(message(1, "resume"));
    await manager.close();

    expect(restoredSession).toEqual({
      file: "/sessions/old.jsonl",
      missingPolicy: "error",
    });
    expect(logger.entries).toContainEqual({
      event: "pi_session_ready",
      fields: {
        chat_id: 1,
        resumed: true,
        is_streaming: false,
        pending_message_count: 0,
      },
    });
  });

  test("workspace fork 未落盘时拒绝把它当作可丢弃空 session", async () => {
    class ForkedSessionClient extends FakePiClient {
      override readonly sessionLaunchMode = "fork" as const;
    }

    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const oldSession = { id: "old", file: "/sessions/old.jsonl" };
    await stateStore.update((state) => {
      state.chats["1"] = {
        session: oldSession,
        messageOrder: [],
        messages: {},
      };
    });
    const client = new ForkedSessionClient(
      "new",
      join(directory, "missing-fork.jsonl"),
    );
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async () => undefined,
      },
    });

    await expect(manager.status(1)).rejects.toThrow(
      "Pi fork session 文件尚未落盘",
    );
    await manager.close();

    expect(stateStore.snapshot().chats["1"]?.session).toEqual(oldSession);
  });

  test("workspace 变化时接受 fork 产生的新 session", async () => {
    class ForkedSessionClient extends FakePiClient {
      override readonly sessionLaunchMode = "fork" as const;
    }

    const directory = await mkdtemp(join(tmpdir(), "amadeus-agent-"));
    temporaryDirectories.push(directory);
    const stateStore = await StateStore.open(join(directory, "state.json"));
    const forkFile = join(directory, "new.jsonl");
    await writeFile(forkFile, "forked session\n");
    await stateStore.update((state) => {
      state.chats["1"] = {
        session: { id: "old", file: "/sessions/old.jsonl" },
        messageOrder: [],
        messages: {},
      };
    });
    const client = new ForkedSessionClient("new", forkFile);
    const logger = new RecordingLogger();
    const manager = new PiAgentManager({
      stateStore,
      clientFactory: { create: async () => client },
      downloader: { download: async (attachment) => attachment },
      logger,
      callbacks: {
        onEvent: () => undefined,
        onFinalResponse: async () => undefined,
        onSessionReset: async () => undefined,
        onError: async () => undefined,
      },
    });

    await manager.submit(message(1, "migrate workspace"));
    await manager.close();

    expect(stateStore.snapshot().chats["1"]?.session).toEqual({
      id: "new",
      file: forkFile,
      materialized: true,
    });
    expect(logger.entries).toContainEqual({
      event: "pi_session_ready",
      fields: {
        chat_id: 1,
        resumed: false,
        is_streaming: false,
        pending_message_count: 0,
      },
    });
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("等待测试条件超时");
}

function message(messageId: number, text: string): NormalizedTelegramMessage {
  return {
    updateId: messageId,
    chatId: 1,
    messageId,
    sentAt: "2026-09-01T00:00:00Z",
    sender: { id: 1, displayName: "User" },
    text,
    attachments: [],
  };
}
