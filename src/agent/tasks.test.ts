import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import {
  CompactionEntry,
  CompactionTask,
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
  hook,
  InboxDoc,
  LiveDoc,
  type Conversation,
  type TaskId,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { addAbortListener } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IDLE_COMPACTION_MS,
  IdleCompactionState,
  createTasksExtension,
} from "./tasks";

const context = BACKGROUND_CONTEXT;
const minute = 60_000;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

// 等待真实提交事件，不轮询时间，也不等待现实中的 40 分钟。
async function until<T>(
  harness: Harness,
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
): Promise<T> {
  let changed = Promise.withResolvers<void>();
  const observation = harness.observeCommits({
    advance() {
      const previous = changed;
      changed = Promise.withResolvers<void>();
      previous.resolve();
    },
    end() {},
  });
  try {
    for (;;) {
      const next = changed.promise;
      const value = await read();
      if (predicate(value)) return value;
      await next;
    }
  } finally {
    observation.detach();
  }
}

async function fixture(keepRecentTokens = 64) {
  const directory = await mkdtemp(join(tmpdir(), "amadeus-tasks-test-"));
  let now = 0;
  let summaries = 0;
  let replyGate: Promise<void> | undefined;
  let summaryGate: Promise<void> | undefined;
  let summaryStarted = Promise.withResolvers<void>();
  const reports: unknown[] = [];
  async function wait(gate: Promise<void> | undefined, signal?: AbortSignal) {
    const cancelled = Promise.withResolvers<void>();
    using resources = new DisposableStack();
    if (signal)
      resources.use(addAbortListener(signal, () => cancelled.resolve()));
    await Promise.race([gate ?? Promise.resolve(), cancelled.promise]);
  }
  const faux = fauxProvider({
    models: [{ id: "test", contextWindow: 128_000 }],
  });
  faux.setResponses(
    Array.from({ length: 40 }, () => async (request, options) => {
      const first = request.messages[0];
      if (
        first?.role === "system" &&
        typeof first.content === "string" &&
        first.content.includes("context summarization assistant")
      ) {
        summaries++;
        summaryStarted.resolve();
        await wait(summaryGate, options?.signal);
        return fauxAssistantMessage(
          "## Goal\nPreserve the user's project facts.",
        );
      }
      await wait(replyGate, options?.signal);
      return fauxAssistantMessage("answer ".repeat(120));
    }),
  );
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const tasks = createTasksExtension();
  registry.install(tasks.extension);
  let harness: Harness;
  let activity: Awaited<ReturnType<typeof tasks.watch>>;
  let root: Conversation;
  async function open() {
    const database = await openNodeSqliteDatabase(
      join(directory, "session.sqlite"),
    );
    harness = await Harness.open(
      await SqliteStorage.open(database),
      {
        models,
        registry,
        now: () => now,
        onWake() {},
        settings: { retry: { enabled: false } },
        onReport: (report) => reports.push(report.error),
      },
      context,
    );
    root = await harness.root(context, {
      agent: {
        model: { provider: "faux", modelId: "test" },
        compaction: { enabled: false, keepRecentTokens },
      },
    });
    activity = await tasks.watch(harness);
    harness.resume();
  }
  async function close() {
    await activity.close();
    await harness.close(context);
  }
  cleanups.push(async () => {
    try {
      await close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await open();
  async function state(conversation = root) {
    return harness.commit(
      async (tx) => ({
        ...(await tx.doc(IdleCompactionState, conversation.id)),
      }),
      context,
    );
  }
  async function timer(conversation = root) {
    const value = await until(
      harness,
      () => state(conversation),
      (value) => value.timer !== null,
    );
    // 上面的事件等待已经确认任务引用非空。
    const id = value.timer!;
    await until(
      harness,
      () => harness.getTask(id, context),
      (value) => value?.state.status === "sleeping",
    );
    return id;
  }
  return {
    registry,
    reports,
    faux,
    get harness() {
      return harness;
    },
    get root() {
      return root;
    },
    get now() {
      return now;
    },
    get summaries() {
      return summaries;
    },
    state,
    timer,
    close,
    stopActivity: () => activity.close(),
    async reopen(elapsed = 0) {
      await close();
      now += elapsed;
      await open();
    },
    advance(elapsed: number) {
      now += elapsed;
      harness.resume();
    },
    holdReply(gate: Promise<void> | undefined) {
      replyGate = gate;
    },
    holdSummary(gate: Promise<void> | undefined) {
      summaryGate = gate;
      summaryStarted = Promise.withResolvers<void>();
      return summaryStarted.promise;
    },
    async ask(conversation = root) {
      await (
        await conversation.submit(
          { type: "input", content: "Keep this fact. ".repeat(100) },
          context,
        )
      ).wait(context);
      await conversation.waitForIdle(context);
      return timer(conversation);
    },
    async compactions() {
      return harness.commit(
        (tx) => tx.scanTasks({ kind: CompactionTask.definition.name }, 100),
        context,
      );
    },
    async finish(id: TaskId<null>) {
      await harness.waitForTask(id, context);
      const page = await this.compactions();
      for (const task of page.items)
        await harness.waitForTask(task.id, context);
    },
  };
}

test("闲置满 40 分钟只压缩一次，保留原始历史且后台任务不占忙碌状态", async () => {
  const f = await fixture();
  expect(IDLE_COMPACTION_MS).toBe(40 * minute);
  const timer = await f.ask();
  await f.harness.waitForIdle(context);
  expect(f.harness.wake()).toEqual({ active: false, at: IDLE_COMPACTION_MS });
  const before = await f.root.entries(
    { order: "ascending" },
    100,
    undefined,
    context,
  );
  f.advance(IDLE_COMPACTION_MS - 1);
  expect((await f.harness.getTask(timer, context))?.state.status).toBe(
    "sleeping",
  );
  expect(f.summaries).toBe(0);
  f.advance(1);
  await f.finish(timer);
  expect(f.summaries).toBe(1);
  const view = await f.root.context(context);
  expect(CompactionEntry.is(view.head)).toBe(true);
  const after = await f.root.entries(
    { order: "ascending" },
    100,
    undefined,
    context,
  );
  for (const entry of before.items) expect(after.items).toContainEqual(entry);
  expect((await f.state()).timer).toBeNull();
  f.advance(IDLE_COMPACTION_MS * 2);
  expect((await f.compactions()).items).toHaveLength(1);
  expect(f.reports).toEqual([]);
});

test("新一轮活动延后期限并复用同一个睡眠任务", async () => {
  const f = await fixture();
  const timer = await f.ask();
  f.advance(30 * minute);
  expect(await f.ask()).toBe(timer);
  f.advance(10 * minute);
  await until(
    f.harness,
    () => f.harness.getTask(timer, context),
    (value) =>
      value?.state.status === "sleeping" && value.state.until === 70 * minute,
  );
  expect(f.summaries).toBe(0);
  f.advance(30 * minute);
  await f.finish(timer);
  expect(f.summaries).toBe(1);
});

test("运行中的模型不被闲置任务打断，从回答结束重新计时", async () => {
  const f = await fixture();
  const timer = await f.ask();
  const gate = Promise.withResolvers<void>();
  try {
    f.advance(39 * minute);
    f.holdReply(gate.promise);
    const input = await f.root.submit(
      { type: "input", content: "A long task" },
      context,
    );
    f.advance(minute);
    await f.harness.waitForTask(timer, context);
    expect(f.summaries).toBe(0);
    expect(
      (await f.harness.snapshot(LiveDoc, f.root.id, context))?.run,
    ).toBeDefined();
    f.advance(20 * minute);
    gate.resolve();
    await input.wait(context);
    await f.root.waitForIdle(context);
    const next = await f.timer();
    expect(next).not.toBe(timer);
    expect(f.harness.wake()).toEqual({ active: false, at: 100 * minute });
    f.advance(40 * minute);
    await f.finish(next);
    expect(f.summaries).toBe(1);
  } finally {
    gate.resolve();
  }
});

test("回答结束与旧期限同时发生时仍从本次结束重新计时", async () => {
  const f = await fixture();
  await f.ask();
  const gate = Promise.withResolvers<void>();
  try {
    f.advance(39 * minute);
    f.holdReply(gate.promise);
    const input = await f.root.submit(
      { type: "input", content: "Finish at the old deadline" },
      context,
    );
    f.advance(minute);
    gate.resolve();
    await input.wait(context);
    await f.root.waitForIdle(context);
    await until(
      f.harness,
      () => f.state(),
      (state) => state.at === 40 * minute && state.timer !== null,
    );
    const timer = await f.timer();
    expect(f.summaries).toBe(0);
    expect(f.harness.wake()).toEqual({ active: false, at: 80 * minute });
    f.advance(40 * minute);
    await f.finish(timer);
    expect(f.summaries).toBe(1);
  } finally {
    gate.resolve();
  }
});

test("尚未开始模型请求的输入准备任务也阻止闲置压缩", async () => {
  const f = await fixture();
  const timer = await f.ask();
  const gate = Promise.withResolvers<void>();
  const preparation = defineTask<null, { phase: "prepare" }, null>({
    name: "test.prepare",
    version: 1,
    initial: () => ({ phase: "prepare" }),
    phases: {
      prepare: async (_task, runtime, context) => {
        await gate.promise;
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: null },
          }),
          context,
        );
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      );
    },
  });
  f.registry.install(
    defineExtension({ name: "test.prepare", tasks: [preparation] }),
  );
  try {
    f.advance(39 * minute);
    const work = await f.root.commit(
      (tx) =>
        tx.createTask(preparation, null, {
          ownership: { kind: "conversation" },
        }),
      context,
    );
    f.advance(minute);
    await f.harness.waitForTask(timer, context);
    expect(f.summaries).toBe(0);
    f.advance(2 * minute);
    gate.resolve();
    await f.harness.waitForTask(work, context);
    const next = await f.timer();
    expect(f.harness.wake()).toEqual({ active: false, at: 82 * minute });
    f.advance(40 * minute);
    await f.finish(next);
    expect(f.summaries).toBe(1);
  } finally {
    gate.resolve();
  }
});

test("重启保留原期限，停机跨过期限后恢复压缩且不重复领取", async () => {
  const f = await fixture();
  const timer = await f.ask();
  f.advance(30 * minute);
  await f.reopen(5 * minute);
  expect(await f.timer()).toBe(timer);
  expect(f.harness.wake()).toEqual({ active: false, at: 40 * minute });
  await f.reopen(10 * minute);
  await f.finish(timer);
  expect(f.summaries).toBe(1);
  await f.reopen(60 * minute);
  expect((await f.state()).timer).toBeNull();
  expect((await f.compactions()).items).toHaveLength(1);
});

test("启动从原生结束记录补齐错过的活动事件，不把期限改成启动时间", async () => {
  const f = await fixture();
  await f.ask();
  await f.stopActivity();
  f.advance(30 * minute);
  await (
    await f.root.submit({ type: "input", content: "New fact" }, context)
  ).wait(context);
  await f.root.waitForIdle(context);
  await f.reopen(15 * minute);
  const timer = await f.timer();
  expect((await f.state()).at).toBe(30 * minute);
  expect(f.harness.wake()).toEqual({ active: false, at: 70 * minute });
  f.advance(25 * minute);
  await f.finish(timer);
  expect(f.summaries).toBe(1);
});

test("短上下文按原生保留策略跳过，不调用模型也不反复压缩", async () => {
  const f = await fixture(20_000);
  const timer = await f.ask();
  f.advance(IDLE_COMPACTION_MS);
  await f.finish(timer);
  expect(f.summaries).toBe(0);
  expect((await f.root.context(context)).head).toBeUndefined();
  await f.reopen(IDLE_COMPACTION_MS);
  expect((await f.state()).timer).toBeNull();
  expect((await f.compactions()).items).toHaveLength(1);
});

test("不同会话分别计时，空会话不创建定时任务", async () => {
  const f = await fixture();
  expect((await f.harness.inspect(context)).tasks).toHaveLength(0);
  const first = await f.ask();
  f.advance(20 * minute);
  const other = await f.harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: await f.root.agent(context) },
    context,
  );
  const second = await f.ask(other);
  f.advance(20 * minute);
  await f.finish(first);
  expect(CompactionEntry.is((await f.root.context(context)).head)).toBe(true);
  expect((await other.context(context)).head).toBeUndefined();
  f.advance(20 * minute);
  await f.finish(second);
  expect(f.summaries).toBe(2);
});

test("到期时已有原生压缩则不重复启动", async () => {
  const f = await fixture();
  const timer = await f.ask();
  const gate = Promise.withResolvers<void>();
  try {
    f.holdSummary(gate.promise);
    const compact = await f.root.compact(undefined, context);
    f.advance(IDLE_COMPACTION_MS);
    await f.harness.waitForTask(timer, context);
    expect((await f.compactions()).items).toHaveLength(1);
    gate.resolve();
    await f.harness.waitForTask(compact, context);
    expect(f.summaries).toBe(1);
  } finally {
    gate.resolve();
  }
});

test("停止和重置沿用原生取消，后续新输入可以重新安排任务", async () => {
  const f = await fixture();
  const timer = await f.ask();
  await f.root.abort(context, { background: true });
  expect((await f.harness.getTask(timer, context))?.state.outcome?.status).toBe(
    "aborted",
  );
  expect((await f.state()).timer).toBeNull();
  await f.root.reset(undefined, context);
  f.advance(IDLE_COMPACTION_MS);
  expect(f.summaries).toBe(0);
  const next = await f.ask();
  expect(next).not.toBe(timer);
  f.advance(IDLE_COMPACTION_MS);
  await f.finish(next);
  expect(f.summaries).toBe(1);
  expect(f.reports).toEqual([]);
});

test("压缩期间的新输入继续执行，摘要通过原生边界放置且保留新消息", async () => {
  const f = await fixture();
  const timer = await f.ask();
  const summary = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<void>();
  try {
    const started = f.holdSummary(summary.promise);
    f.advance(IDLE_COMPACTION_MS);
    await started;
    f.holdReply(reply.promise);
    const input = await f.root.submit(
      { type: "input", content: "New message during compaction" },
      context,
    );
    summary.resolve();
    await f.finish(timer);
    const inbox = await f.harness.snapshot(InboxDoc, f.root.id, context);
    expect(inbox?.items).toHaveLength(1);
    expect(CompactionEntry.is((await f.root.context(context)).head)).toBe(
      false,
    );
    reply.resolve();
    await input.wait(context);
    await f.root.waitForIdle(context);
    const view = await f.root.context(context);
    expect(CompactionEntry.is(view.head)).toBe(true);
    expect(JSON.stringify(view.messages)).toContain(
      "New message during compaction",
    );
    expect((await f.compactions()).items).toHaveLength(1);
  } finally {
    summary.resolve();
    reply.resolve();
  }
});

test("压缩请求被关闭打断后恢复同一个原生任务，不重复创建压缩", async () => {
  const f = await fixture();
  const timer = await f.ask();
  const gate = Promise.withResolvers<void>();
  try {
    const started = f.holdSummary(gate.promise);
    f.advance(IDLE_COMPACTION_MS);
    await started;
    const before = (await f.compactions()).items;
    expect(before).toHaveLength(1);
    f.holdSummary(undefined);
    await f.reopen();
    await f.finish(timer);
    const after = (await f.compactions()).items;
    expect(after.map((task) => task.id)).toEqual(before.map((task) => task.id));
    expect(CompactionEntry.is((await f.root.context(context)).head)).toBe(true);
    expect(f.reports).toEqual([]);
  } finally {
    gate.resolve();
  }
});

test("失败的运行也更新闲置期限，不依赖成功回答钩子", async () => {
  const f = await fixture();
  const timer = await f.ask();
  f.advance(30 * minute);
  f.faux.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "original generation failure",
    }),
    fauxAssistantMessage("## Goal\nPreserve the existing facts."),
  ]);
  const result = await (
    await f.root.submit(
      { type: "input", content: "This request fails" },
      context,
    )
  ).wait(context);
  expect(result.status).toBe("unanswered");
  await f.root.waitForIdle(context);
  expect(await f.timer()).toBe(timer);
  f.advance(10 * minute);
  await until(
    f.harness,
    () => f.harness.getTask(timer, context),
    (task) =>
      task?.state.status === "sleeping" && task.state.until === 70 * minute,
  );
  expect((await f.compactions()).items).toHaveLength(0);
  f.advance(30 * minute);
  await f.finish(timer);
  expect(CompactionEntry.is((await f.root.context(context)).head)).toBe(true);
});

test("压缩失败保留原生错误，不另加重试循环", async () => {
  const f = await fixture();
  const timer = await f.ask();
  const error = new Error("original compaction failure");
  f.registry.install(
    defineExtension({
      name: "test.compaction-error",
      hooks: [
        hook(CompactionTask, {
          beforeCompact() {
            throw error;
          },
        }),
      ],
    }),
  );
  f.advance(IDLE_COMPACTION_MS);
  await f.finish(timer);
  expect(f.reports).toContain(error);
  expect((await f.compactions()).items).toHaveLength(1);
  f.advance(IDLE_COMPACTION_MS);
  expect((await f.compactions()).items).toHaveLength(1);
});
