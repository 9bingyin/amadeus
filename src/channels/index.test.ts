import { afterEach, expect, test } from "bun:test";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
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
import { runChannels, type Channel } from ".";

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
