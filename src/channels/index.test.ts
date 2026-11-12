import { afterEach, expect, spyOn, test } from "bun:test";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import {
  getCurrentSystemPrompt,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { contentText } from "@earendil-works/pi-ai/utils/text";
import {
  AssistantEntry,
  createRegistry,
  Harness,
  MemoryStorage,
  type ConversationId,
} from "@earendil-works/pi-durable";
import {
  mkdtemp,
  mkdir,
  rm,
  stat,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAgent } from "../agent";
import { parseConfig } from "../config";
import { openChannels, runChannels, type Channel } from ".";
import { openIpc } from "./ipc";
import * as telegram from "./telegram";

const context = BACKGROUND_CONTEXT;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry: createRegistry() },
    context,
  );
  cleanups.push(() => harness.close(context));
  return { harness, faux };
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function agentFixture() {
  const directory = await mkdtemp(join(tmpdir(), "amadeus-channels-"));
  const config = parseConfig(
    {
      channels: { telegram: { token: "123:TEST", allowedUserIds: [1] } },
      agent: { model: { provider: "faux", modelId: "test" } },
      providers: { faux: { apiKey: "test" } },
    },
    directory,
  );
  const faux = fauxProvider({ models: [{ id: "test" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const agent = await openAgent(config, models);
  cleanups.push(async () => {
    try {
      await agent.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  return { agent, config, directory, faux };
}

test("Agent 不启动 IPC，openChannels 默认打开内部 IPC 接入并统一停止", async () => {
  const f = await agentFixture();
  const path = join(f.directory, "ipc", "notify.sock");
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.agent.registry.snapshot().extension("amadeus.ipc")).toBeUndefined();
  const root = await f.agent.harness.root(context, {
    agent: f.agent.configuration,
  });
  function response(active: boolean) {
    return (request: TranscriptContext) => {
      const prompt = getCurrentSystemPrompt(request.messages);
      expect(prompt).toContain("<platform>\n<ipc>");
      expect(prompt).not.toContain("<telegram>");
      expect(prompt).not.toContain("<notifications>");
      expect(prompt).toContain("Reply to the user yourself");
      expect(prompt.includes('bun run "$AMADEUS_NOTIFY_CLI"')).toBe(active);
      return fauxAssistantMessage("Harness is still open");
    };
  }
  f.faux.setResponses([response(false)]);
  await (
    await root.submit({ type: "input", content: "before IPC" }, context)
  ).wait(context);
  const channels = await openChannels(f.agent, {});
  expect(channels).toHaveLength(1);
  expect((await stat(path)).isSocket()).toBe(true);
  f.faux.setResponses([response(true)]);
  await (
    await root.submit({ type: "input", content: "with IPC" }, context)
  ).wait(context);
  await runChannels([...channels, { async run() {} }], f.agent.harness);
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    f.agent.registry.snapshot().extension("amadeus.ipc")?.wraps,
  ).toBeUndefined();
  expect(f.agent.registry.snapshot().task("amadeus.ipc.notify")).toBeDefined();
  f.faux.setResponses([response(false)]);
  expect(
    (
      await (
        await root.submit({ type: "input", content: "continue" }, context)
      ).wait(context)
    ).status,
  ).toBe("done");
});

test("IPC 注册失败会清理 Socket，但不关闭共享 Harness", async () => {
  const f = await agentFixture();
  const failure = new TypeError("original IPC registry failure");
  const install = f.agent.registry.install.bind(f.agent.registry);
  const registration = spyOn(f.agent.registry, "install").mockImplementation(
    (extension) => {
      if (extension.name === "amadeus.ipc" && extension.wraps) throw failure;
      install(extension);
    },
  );
  try {
    await expect(openIpc(f.agent)).rejects.toBe(failure);
    await expect(
      stat(join(f.directory, "ipc", "notify.sock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await f.agent.harness.root(context)).id).toBeDefined();
  } finally {
    registration.mockRestore();
  }
});

test("后续接入启动失败会收尾已打开接入，保留原始错误与用户文件", async () => {
  const f = await agentFixture();
  const directory = join(f.directory, "ipc");
  await mkdir(directory);
  const path = join(directory, "notify.sock");
  await writeFile(path, "preserve this file");
  let stopped = false;
  const opened = spyOn(telegram, "openTelegram").mockResolvedValue({
    async run(signal) {
      stopped = signal.aborted;
    },
  });
  try {
    await expect(
      openChannels(f.agent, f.config.channels),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(stopped).toBe(true);
    expect(await readFile(path, "utf8")).toBe("preserve this file");
    expect((await f.agent.harness.root(context)).id).toBeDefined();
  } finally {
    opened.mockRestore();
  }
});

test("Harness resume 失败也会停止已打开的所有接入", async () => {
  const { harness } = await fixture();
  const failure = new Error("original resume failure");
  const resume = spyOn(harness, "resume").mockImplementation(() => {
    throw failure;
  });
  let started = false;
  let stopped = false;
  try {
    await expect(
      runChannels(
        [
          {
            async run(signal) {
              started = true;
              await aborted(signal);
              stopped = true;
            },
          },
        ],
        harness,
      ),
    ).rejects.toBe(failure);
    expect(started).toBe(true);
    expect(stopped).toBe(true);
  } finally {
    resume.mockRestore();
  }
});

test("两个独立接入共享 Harness，使用原生会话隔离上下文与 requestId", async () => {
  const { harness, faux } = await fixture();
  const before = {
    interrupt: process.listenerCount("SIGINT"),
    terminate: process.listenerCount("SIGTERM"),
  };
  const replies = new Map<string, string>();
  const conversations = new Set<ConversationId>();
  const finished = Promise.withResolvers<void>();
  faux.setResponses(
    [0, 1].map(() => (request) => {
      const input = request.messages.filter(
        (message) => message.role === "user",
      );
      expect(input).toHaveLength(1);
      return fauxAssistantMessage(contentText(input[0]?.content ?? []));
    }),
  );
  const channels: Channel[] = ["console", "web"].map((name) => ({
    async run(signal) {
      const ctx = withAbortSignal(signal, context);
      const conversation = await harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: { model: { provider: "faux", modelId: "faux-1" } },
        },
        ctx,
      );
      conversations.add(conversation.id);
      const input = await conversation.submit(
        { type: "input", content: name, requestId: "same-request" },
        ctx,
      );
      expect((await input.wait(ctx)).status).toBe("done");
      const answer = (await conversation.entries({}, 10, undefined, ctx)).items
        .find(AssistantEntry.is)
        ?.model?.find((message) => message.role === "assistant");
      replies.set(name, contentText(answer?.content ?? []));
      if (replies.size === 2) finished.resolve();
      await Promise.race([finished.promise, aborted(signal)]);
    },
  }));
  await runChannels(channels, harness);
  expect(conversations.size).toBe(2);
  expect(replies.get("console")).toBe("console");
  expect(replies.get("web")).toBe("web");
  expect(process.listenerCount("SIGINT")).toBe(before.interrupt);
  expect(process.listenerCount("SIGTERM")).toBe(before.terminate);
  // 接入停止不拥有共享 Agent 的关闭权，宿主仍可提交原生操作。
  expect((await harness.root(context)).id).toBeDefined();
});

test("一个接入故障会停止其余接入并等待收尾，原始错误对象不被包装", async () => {
  const { harness } = await fixture();
  const failure = {
    message: "original channel failure",
    detail: { channel: "first" },
  };
  let stopped = false;
  const channels: Channel[] = [
    {
      async run() {
        throw failure;
      },
    },
    {
      async run(signal) {
        await aborted(signal);
        stopped = true;
      },
    },
  ];
  await expect(runChannels(channels, harness)).rejects.toBe(failure);
  expect(stopped).toBe(true);
});

test("正常退出仍会等待其他接入收尾，收尾异常原样抛出", async () => {
  const { harness } = await fixture();
  const failure = new TypeError("original channel cleanup failure");
  const channels: Channel[] = [
    { async run() {} },
    {
      async run(signal) {
        await aborted(signal);
        throw failure;
      },
    },
  ];
  await expect(runChannels(channels, harness)).rejects.toBe(failure);
});

test("共享 Harness 关闭时会停止所有接入", async () => {
  const { harness } = await fixture();
  const started = Promise.withResolvers<void>();
  let stopped = false;
  const running = runChannels(
    [
      {
        async run(signal) {
          started.resolve();
          await aborted(signal);
          stopped = true;
        },
      },
    ],
    harness,
  );
  await started.promise;
  await harness.close(context);
  await running;
  expect(stopped).toBe(true);
});
