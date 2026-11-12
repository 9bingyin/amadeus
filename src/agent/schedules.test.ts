import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  getCurrentSystemPrompt,
  getCurrentTools,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { contentText } from "@earendil-works/pi-ai/utils/text";
import {
  createRegistry,
  defineExtension,
  defineTask,
  GenerationTask,
  hook,
  runEndTask,
  wrapTool,
  Harness,
  ToolResultEntry,
  type Conversation,
  type JsonObject,
  type TaskId,
} from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { watch } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  NotificationEntry,
  NotificationTask,
  NotificationsExtension,
} from "../channels/notifications";
import { createSchedulesExtension, Schedules } from "./schedules";
import { ScheduleResult, ScheduleWorker } from "./schedule-loop";

const context = BACKGROUND_CONTEXT;
const recurring: JsonObject[] = [
  { kind: "every", intervalMs: 1000 },
  { kind: "cron", expression: "* * * * * *", timezone: "UTC" },
];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function until<T>(
  harness: Harness,
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
) {
  let changed = Promise.withResolvers<void>();
  const observer = harness.observeCommits({
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
    observer.detach();
  }
}
async function exists(path: string, directory: string) {
  const ready = Promise.withResolvers<void>();
  const watcher = watch(directory, () => ready.resolve());
  try {
    if (!(await Bun.file(path).exists())) await ready.promise;
  } finally {
    watcher.close();
  }
}

async function fixture(initialNow = 1_000_000, worker?: FauxResponseFactory) {
  const directory = await mkdtemp(join(tmpdir(), "amadeus-schedules-"));
  const workspace = join(directory, "work space");
  await mkdir(workspace);
  let now = initialNow;
  let harness: Harness;
  let root: Conversation;
  const reports: unknown[] = [];
  const workerRequests: TranscriptContext[] = [];
  const mainRequests: TranscriptContext[] = [];
  const requests = new Map<string, { name: string; args: JsonObject }>();
  let serial = 0;
  const faux = fauxProvider({
    models: [{ id: "test", contextWindow: 128_000 }],
  });
  faux.setResponses(
    Array.from({ length: 200 }, () => (request, options, state, model) => {
      if (
        worker &&
        getCurrentSystemPrompt(request.messages).includes("<scheduled_worker>")
      ) {
        workerRequests.push(request);
        return worker(request, options, state, model);
      }
      mainRequests.push(request);
      const message = request.messages.findLast(
        (message) => message.role !== "system",
      );
      const text = contentText(message?.content ?? []);
      const call = requests.get(text);
      if (message?.role === "user" && call)
        return fauxAssistantMessage(fauxToolCall(call.name, call.args), {
          stopReason: "toolUse",
        });
      return fauxAssistantMessage("handled");
    }),
  );
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(NotificationsExtension);
  if (worker) registry.install(createCodingTools());
  registry.install(
    createSchedulesExtension(directory, (id, context) =>
      harness.abortTask(id, context),
    ),
  );
  async function open() {
    harness = await Harness.open(
      await SqliteStorage.open(
        await openNodeSqliteDatabase(join(directory, "session.sqlite")),
      ),
      {
        models,
        registry,
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? workspace }),
        now: () => now,
        settings: { retry: { enabled: false }, afterFailedRun: "continue" },
        onWake() {},
        onReport: (report) => reports.push(report.error),
      },
      context,
    );
    root = await harness.root(context, {
      agent: {
        model: { provider: "faux", modelId: "test" },
        cwd: workspace,
        compaction: { enabled: false },
      },
    });
    harness.resume();
  }
  cleanups.push(async () => {
    try {
      await harness.close(context);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await open();
  async function tool(action: string, args: JsonObject, conversation = root) {
    const text = `tool:${++serial}`;
    requests.set(text, { name: "schedule", args: { action, ...args } });
    await (
      await conversation.submit({ type: "input", content: text }, context)
    ).wait(context);
    await conversation.waitForIdle(context);
    const entries = await conversation.entries({}, 100, undefined, context);
    const entry = entries.items
      .filter(ToolResultEntry.is)
      .find((entry) =>
        entry.model?.some(
          (message) =>
            message.role === "toolResult" && message.toolName === "schedule",
        ),
      );
    const result = entry?.model?.find(
      (message) => message.role === "toolResult",
    );
    return {
      isError: result?.isError ?? false,
      text: contentText(result?.content ?? []),
    };
  }
  async function create(
    execution: string | { prompt: string },
    when: JsonObject = { kind: "after", delayMs: 1000 },
    conversation = root,
  ) {
    const result = await tool(
      "create",
      {
        name: "test schedule",
        ...(typeof execution === "string" ? { command: execution } : execution),
        when,
      },
      conversation,
    );
    expect(result.isError).toBe(false);
    const created = z
      .object({ id: z.int().positive(), nextAt: z.int() })
      .parse(JSON.parse(result.text));
    // 创建工具返回的是已校验正整数的原生任务 ID。
    return { ...created, id: created.id as TaskId<null> };
  }
  async function run(id: TaskId<null>, previous?: TaskId) {
    const catalog = await until(
      harness,
      () => harness.snapshot(Schedules, root.id, context),
      (catalog) => {
        const last = catalog?.jobs[id]?.lastRun;
        return last !== undefined && last !== null && last !== previous;
      },
    );
    // 上面的等待已经确认目录中存在本次运行引用。
    const runId = catalog!.jobs[id]!.lastRun!;
    const result = await harness.waitForTask(runId, context);
    await until(
      harness,
      () => harness.getTask(id, context),
      (task) =>
        task?.state.status === "sleeping" || task?.state.status === "terminal",
    );
    const notifications = await harness.commit(
      (tx) => tx.scanTasks({ kind: NotificationTask.definition.name }, 100),
      context,
    );
    for (const task of notifications.items)
      await harness.waitForTask(task.id, context);
    await root.waitForIdle(context);
    return result;
  }
  return {
    directory,
    workspace,
    reports,
    workerRequests,
    mainRequests,
    faux,
    registry,
    tool,
    create,
    run,
    get harness() {
      return harness;
    },
    get root() {
      return root;
    },
    get now() {
      return now;
    },
    advance(ms: number) {
      now += ms;
      harness.resume();
    },
    async reopen(ms = 0) {
      await harness.close(context);
      now += ms;
      await open();
    },
    async notifications() {
      return (
        await root.entries({ order: "ascending" }, 100, undefined, context)
      ).items.filter(NotificationEntry.is);
    },
  };
}

function complete(decision: JsonObject) {
  return fauxAssistantMessage(fauxToolCall("schedule_result", decision), {
    stopReason: "toolUse",
  });
}

test("定时 Agent 使用原生工具 Loop，已处理的工具错误和静默结果不唤醒主会话", async () => {
  let round = 0;
  const f = await fixture(1_000_000, (request) => {
    const names = getCurrentTools(request.messages).map(({ name }) => name);
    expect(names).toContain("schedule_result");
    expect(names).not.toContain("schedule");
    expect(names).not.toContain("send_file");
    expect(getCurrentSystemPrompt(request.messages)).not.toContain(
      "<scheduled>",
    );
    if (round++ === 0)
      return fauxAssistantMessage(
        fauxToolCall("bash", { command: "printf diagnostic >&2; exit 7" }),
        { stopReason: "toolUse" },
      );
    expect(
      request.messages.findLast((message) => message.role === "toolResult")
        ?.isError,
    ).toBe(true);
    return complete({ notify: false });
  });
  const plan = await f.create({
    prompt: "处理检查错误；不需要用户关注则静默。",
  });
  const main = f.mainRequests.length;
  f.advance(1000);
  const run = await f.run(plan.id);
  expect(run.state.outcome.result).toMatchObject({
    kind: "agent",
    status: "completed",
    decision: { notify: false },
  });
  expect(f.workerRequests).toHaveLength(2);
  expect(f.mainRequests).toHaveLength(main);
  expect(await f.notifications()).toHaveLength(0);
  expect(
    getCurrentTools(f.mainRequests[0]?.messages ?? []).map(({ name }) => name),
  ).not.toContain("schedule_result");
  expect(f.reports).toEqual([]);
});

test("周期 Agent 跨重启复用 Worker 和历史，只在明确需要时报告", async () => {
  let runs = 0;
  const f = await fixture(1_000_000, (request) => {
    const index = runs++;
    if (index === 0) return fauxAssistantMessage("已记录基线，无需关注。");
    if (index === 2) return fauxAssistantMessage("已报告的故障没有变化。");
    expect(
      request.messages.some(
        (message) =>
          message.role === "assistant" &&
          contentText(message.content) === "已记录基线，无需关注。",
      ),
    ).toBe(true);
    return complete({ notify: true, message: "发现新故障，请检查服务。" });
  });
  const plan = await f.create(
    { prompt: "比较上次状态，只报告新变化。" },
    { kind: "every", intervalMs: 1000 },
  );
  f.advance(1000);
  const first = await f.run(plan.id);
  const job = (await f.harness.snapshot(Schedules, f.root.id, context))?.jobs[
    plan.id
  ];
  if (!job?.worker) return z.never().parse(job);
  const worker = await f.harness.conversation(job.worker, context);
  expect(await worker?.agent(context)).toMatchObject({
    model: { provider: "faux", modelId: "test" },
    cwd: f.workspace,
  });
  const main = f.mainRequests.length;
  await f.reopen(1000);
  const second = await f.run(plan.id, first.id);
  expect(second.state.outcome.result).toMatchObject({
    kind: "agent",
    worker: job.worker,
    decision: { notify: true },
  });
  expect(await f.notifications()).toHaveLength(1);
  expect((await f.notifications())[0]?.data.message).toBe(
    "发现新故障，请检查服务。",
  );
  expect((await f.notifications())[0]?.data.metadata).toEqual({
    source: "schedule",
    scheduleId: plan.id,
    name: "test schedule",
    runId: second.id,
    runner: "agent",
  });
  const input = contentText(
    f.mainRequests
      .at(-1)
      ?.messages.findLast((message) => message.role === "user")?.content ?? [],
  );
  expect(input).toStartWith("[Schedule ");
  expect(input).toContain('[Metadata: {"source":"schedule"');
  expect(input).not.toContain("<ipc_notification>");
  expect(f.mainRequests).toHaveLength(main + 1);
  expect(f.workerRequests).toHaveLength(2);
  await f.reopen(1000);
  const third = await f.run(plan.id, second.id);
  expect(third.state.outcome.result).toMatchObject({
    decision: { notify: false },
  });
  expect(f.workerRequests).toHaveLength(3);
  expect(f.mainRequests).toHaveLength(main + 1);
  expect(await f.notifications()).toHaveLength(1);
  await f.tool("delete", { id: plan.id });
  expect(await f.harness.conversation(job.worker, context)).toBeDefined();
  expect(f.reports).toEqual([]);
});

test("Worker 普通最终回答直接结束并默认静默，不强制补完成收据", async () => {
  let round = 0;
  const answer = "检查已完成，无需关注。";
  const f = await fixture(1_000_000, () => {
    expect(++round).toBe(1);
    return fauxAssistantMessage(answer);
  });
  const plan = await f.create({ prompt: "检查并完成" });
  const main = f.mainRequests.length;
  f.advance(1000);
  const run = await f.run(plan.id);
  expect(run.state.outcome.result).toMatchObject({
    status: "completed",
    decision: { notify: false },
  });
  expect(f.workerRequests).toHaveLength(1);
  expect(f.mainRequests).toHaveLength(main);
  expect(await f.notifications()).toHaveLength(0);
  const job = (await f.harness.snapshot(Schedules, f.root.id, context))?.jobs[
    plan.id
  ];
  if (!job?.worker) return z.never().parse(job);
  const worker = await f.harness.conversation(job.worker, context);
  const entries = await worker?.entries({}, 100, undefined, context);
  expect(
    entries?.items.some((entry) =>
      entry.model?.some(
        (message) =>
          message.role === "assistant" &&
          contentText(message.content) === answer,
      ),
    ),
  ).toBe(true);
  expect(f.reports).toEqual([]);
});

test("Agent 最终失败报告原始结算内容，周期不立即重试且可在下一周期恢复", async () => {
  let round = 0;
  const f = await fixture(1_000_000, () =>
    round++ === 0
      ? fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "original provider detail",
        })
      : complete({ notify: false }),
  );
  const plan = await f.create(
    { prompt: "检查" },
    { kind: "every", intervalMs: 1000 },
  );
  f.advance(1000);
  const first = await f.run(plan.id);
  expect(first.state.outcome.result).toMatchObject({
    kind: "agent",
    status: "failed",
  });
  expect((await f.notifications())[0]?.data.message).toContain(
    "original provider detail",
  );
  expect(f.workerRequests).toHaveLength(1);
  f.advance(1000);
  await f.run(plan.id, first.id);
  expect(await f.notifications()).toHaveLength(1);
  await f.tool("delete", { id: plan.id });
});

test("删除 Agent 计划原生停止 Worker 和子工具，主会话 stop/reset 不穿透", async () => {
  const f = await fixture(1_000_000, () =>
    fauxAssistantMessage(
      fauxToolCall("bash", {
        command: `printf ready > ${JSON.stringify(marker + ".tmp")}; mv ${JSON.stringify(marker + ".tmp")} ${JSON.stringify(marker)}; sleep 9999`,
      }),
      { stopReason: "toolUse" },
    ),
  );
  const marker = join(f.workspace, "worker-started");
  const plan = await f.create({ prompt: "执行长检查" });
  f.advance(1000);
  await exists(marker, f.workspace);
  await f.root.abort(context, { background: true });
  await f.root.reset(undefined, context);
  const job = (await f.harness.snapshot(Schedules, f.root.id, context))?.jobs[
    plan.id
  ];
  if (!job?.worker || !job.lastRun) return z.never().parse(job);
  expect((await f.harness.getTask(job.lastRun, context))?.state.status).toBe(
    "running",
  );
  expect((await f.tool("delete", { id: plan.id })).isError).toBe(false);
  expect(
    (await f.harness.getTask(job.lastRun, context))?.state.outcome?.status,
  ).toBe("aborted");
  expect(await f.notifications()).toHaveLength(0);
  expect(JSON.parse((await f.tool("list", {})).text)).toEqual({
    schedules: [],
  });
  expect(f.reports).toEqual([]);
});

test("Agent 中途重启复用同次提交，原生 unsafe bash 不重复副作用", async () => {
  let round = 0;
  const f = await fixture(1_000_000, (request) => {
    if (round++ === 0)
      return fauxAssistantMessage(
        fauxToolCall("bash", {
          command: `printf once >> ${JSON.stringify(marker)}; printf ready > ${JSON.stringify(marker + ".tmp")}; mv ${JSON.stringify(marker + ".tmp")} ${JSON.stringify(marker + ".ready")}; sleep 9999`,
        }),
        { stopReason: "toolUse" },
      );
    expect(
      request.messages.findLast((message) => message.role === "toolResult")
        ?.isError,
    ).toBe(true);
    return complete({ notify: true, message: "执行中断，已有副作用需核实。" });
  });
  const marker = join(f.workspace, "worker-effect");
  const plan = await f.create({ prompt: "执行并查证" });
  f.advance(1000);
  await exists(marker + ".ready", f.workspace);
  const before = (await f.harness.snapshot(Schedules, f.root.id, context))
    ?.jobs[plan.id]?.lastRun;
  if (!before) return z.never().parse(before);
  await f.reopen(5000);
  const run = await f.run(plan.id);
  expect(run.id).toBe(before);
  expect(run.state.outcome.result).toMatchObject({
    kind: "agent",
    status: "completed",
    decision: { notify: true },
  });
  expect(await readFile(marker, "utf8")).toBe("once");
  expect(await f.notifications()).toHaveLength(1);
  expect(f.workerRequests).toHaveLength(2);
  expect(f.reports).toEqual([]);
});

test("完成决定已保存但工具未结算时重启，safe 回放不重复唤醒主会话", async () => {
  const f = await fixture(1_000_000, () =>
    complete({ notify: true, message: "完成报告" }),
  );
  const saved = Promise.withResolvers<void>();
  let pause = true;
  f.registry.install(
    defineExtension({
      name: "test-finish-recovery",
      wraps: [
        wrapTool(ScheduleResult, (tool) => ({
          ...tool,
          async execute(args, api, ctx) {
            const result = await tool.execute(args, api, ctx);
            if (pause) {
              pause = false;
              saved.resolve();
              await new Promise<void>((_resolve, reject) => {
                const signal = ctx.abortSignal;
                if (!signal) return z.never().parse(signal);
                signal.addEventListener("abort", () => reject(signal.reason), {
                  once: true,
                });
                if (signal.aborted) reject(signal.reason);
              });
            }
            return result;
          },
        })),
      ],
    }),
  );
  const plan = await f.create({ prompt: "检查并报告" });
  f.advance(1000);
  await saved.promise;
  await f.reopen();
  await f.run(plan.id);
  expect(f.workerRequests).toHaveLength(1);
  expect(await f.notifications()).toHaveLength(1);
  expect((await f.notifications())[0]?.data.message).toBe("完成报告");
  expect(f.reports).toEqual([]);
});

test.each([false, true])(
  "Agent 普通回答和显式报告均等待 afterRun 收尾，不重叠 notify=%s",
  async (notify) => {
    const f = await fixture(1_000_000, () =>
      notify
        ? complete({ notify: true, message: "收尾完成后报告" })
        : fauxAssistantMessage("检查完成。"),
    );
    const started = Promise.withResolvers<void>();
    const Drain = defineTask<null, { phase: "wait" } | { phase: "done" }, null>(
      {
        name: "test.schedule-drain",
        version: 1,
        initial: () => ({ phase: "wait" }),
        phases: {
          wait: async (_task, runtime, ctx) => {
            await runtime.sleepUntil(
              runtime.now() + 5000,
              { phase: "done" },
              ctx,
            );
            started.resolve();
          },
          done: (_task, runtime, ctx) =>
            runtime.commit(
              () => ({
                status: "terminal",
                outcome: { status: "completed", result: null },
              }),
              ctx,
            ),
        },
        abort: (_task, runtime, ctx) =>
          runtime.commit(
            () => ({ status: "terminal", outcome: { status: "aborted" } }),
            ctx,
          ),
      },
    );
    f.registry.install(
      defineExtension({
        name: "test.schedule-after-run",
        tasks: [Drain],
        hooks: [
          hook(GenerationTask, {
            async afterRun(_run, api, ctx) {
              if (
                (await api.snapshot(ScheduleWorker, api.conversationId, ctx))
                  ?.schedule
              )
                return { tasks: [runEndTask(Drain, null)] };
              return undefined;
            },
          }),
        ],
      }),
    );
    const plan = await f.create(
      { prompt: "检查" },
      { kind: "every", intervalMs: 1000 },
    );
    f.advance(1000);
    await started.promise;
    expect(await f.notifications()).toHaveLength(0);
    const runs = await f.harness.commit(
      (tx) => tx.scanTasks({ kind: "amadeus.schedule.agent" }, 100),
      context,
    );
    expect(runs.items).toHaveLength(1);
    f.advance(5000);
    await f.run(plan.id);
    expect((await f.harness.getTask(plan.id, context))?.state).toMatchObject({
      status: "sleeping",
      until: 1_007_000,
    });
    expect(await f.notifications()).toHaveLength(notify ? 1 : 0);
    await f.tool("delete", { id: plan.id });
    expect(f.reports).toEqual([]);
  },
);

test("成功时只有非空白 stdout 通知主会话，stderr 仅落盘", async () => {
  const f = await fixture();
  for (const [command, count] of [
    ["printf 'routine log\\n' >&2", 0],
    ["printf '  \\n\\t'; printf 'another log' >&2", 0],
    ["printf '需要用户关注\\n'; printf 'diagnostic only' >&2", 1],
  ] as const) {
    const schedule = await f.create(command);
    const calls = f.faux.state.callCount;
    f.advance(1000);
    const run = await f.run(schedule.id);
    expect(run.state.outcome.status).toBe("completed");
    expect((await f.notifications()).length).toBe(count);
    expect(f.faux.state.callCount - calls).toBe(count);
  }
  const report = (await f.notifications())[0];
  expect(report?.data.message).toBe("需要用户关注\n");
  expect(report?.data.data).toMatchObject({ kind: "schedule" });
  expect(report?.data.metadata).toMatchObject({
    source: "schedule",
    name: "test schedule",
    runner: "command",
  });
  expect(f.reports).toEqual([]);
});

test("非零退出报告原始 stderr、退出码和日志，通知不会重复", async () => {
  const f = await fixture();
  const schedule = await f.create(
    "printf 'partial report'; printf '原始错误\\n' >&2; exit 7",
  );
  f.advance(1000);
  const run = await f.run(schedule.id);
  expect(run.state.outcome.result).toMatchObject({
    status: "failed",
    exitCode: 7,
  });
  const result = run.state.outcome.result;
  if (result && "stdoutPath" in result) {
    expect(await readFile(result.stdoutPath, "utf8")).toBe("partial report");
    expect(await readFile(result.stderrPath, "utf8")).toBe("原始错误\n");
    expect((await stat(result.stdoutPath)).mode & 0o777).toBe(0o600);
  }
  expect((await f.notifications())[0]?.data.message).toBe("原始错误\n");
  expect(
    (await f.harness.getTask(schedule.id, context))?.state.outcome?.status,
  ).toBe("failed");
  await f.reopen(10000);
  await f.root.waitForIdle(context);
  expect(await f.notifications()).toHaveLength(1);
});

test("延迟、指定时间与周期使用原生时钟，恢复保持期限并合并错过周期", async () => {
  const f = await fixture();
  const once = await f.create("printf 'once'", {
    kind: "at",
    at: new Date(f.now + 5000).toISOString(),
  });
  const periodic = await f.create("printf 'tick'", {
    kind: "every",
    intervalMs: 1000,
  });
  await f.reopen(4500);
  const first = await f.run(periodic.id);
  expect((await f.harness.getTask(periodic.id, context))?.state).toMatchObject({
    status: "sleeping",
    until: 1_005_000,
  });
  expect((await f.harness.getTask(once.id, context))?.state.status).toBe(
    "sleeping",
  );
  f.advance(500);
  await f.run(once.id);
  const second = await f.run(periodic.id, first.id);
  expect(second.id).not.toBe(first.id);
  expect(await f.notifications()).toHaveLength(3);
  await f.tool("delete", { id: periodic.id });
});

test("每 30 分钟、Cron 和一次性定时各自保存期限，重启不逐个补跑", async () => {
  const f = await fixture();
  const every = await f.create("printf interval", {
    kind: "every",
    intervalMs: 1_800_000,
  });
  const cron = await f.create("printf cron", {
    kind: "cron",
    expression: "*/30 * * * *",
    timezone: "UTC",
  });
  const once = await f.create("printf once", {
    kind: "at",
    at: "1970-01-01T08:30:00+08:00",
  });
  expect(every.nextAt).toBe(2_800_000);
  expect(cron.nextAt).toBe(1_800_000);
  expect(once.nextAt).toBe(1_800_000);
  const status = JSON.parse((await f.tool("list", { id: cron.id })).text);
  expect(status.schedules[0].cron).toEqual({
    expression: "*/30 * * * *",
    timezone: "UTC",
  });
  f.advance(800_000);
  const first = await f.run(cron.id);
  await f.run(once.id);
  await f.reopen(7_300_000);
  await f.run(cron.id, first.id);
  await f.run(every.id);
  expect((await f.harness.getTask(cron.id, context))?.state).toMatchObject({
    status: "sleeping",
    until: 10_800_000,
  });
  expect((await f.harness.getTask(every.id, context))?.state).toMatchObject({
    status: "sleeping",
    until: 10_000_000,
  });
  expect(await f.notifications()).toHaveLength(4);
  await f.tool("delete", { id: cron.id });
  await f.tool("delete", { id: every.id });
  expect(f.reports).toEqual([]);
});

test("Cron 保存实际时区，夏令时前后和重启继续按当地时间触发", async () => {
  const f = await fixture(Date.parse("2026-03-28T09:00:00Z"));
  const cron = await f.create("printf daily", {
    kind: "cron",
    expression: "0 9 * * *",
    timezone: "Europe/London",
  });
  expect(cron.nextAt).toBe(Date.parse("2026-03-29T08:00:00Z"));
  f.advance(cron.nextAt - f.now);
  const first = await f.run(cron.id);
  expect((await f.harness.getTask(cron.id, context))?.state).toMatchObject({
    status: "sleeping",
    until: Date.parse("2026-03-30T08:00:00Z"),
  });
  await f.reopen(49 * 60 * 60 * 1000);
  await f.run(cron.id, first.id);
  expect((await f.harness.getTask(cron.id, context))?.state).toMatchObject({
    status: "sleeping",
    until: Date.parse("2026-04-01T08:00:00Z"),
  });
  const status = JSON.parse((await f.tool("list", { id: cron.id })).text);
  expect(status.schedules[0].cron.timezone).toBe("Europe/London");
  expect(await f.notifications()).toHaveLength(2);
  await f.tool("delete", { id: cron.id });
  expect(f.reports).toEqual([]);
});

test("Cron 缺省时区在创建时保存为宿主时区", async () => {
  const f = await fixture();
  const cron = await f.create("true", {
    kind: "cron",
    expression: "0 * * * *",
  });
  const expected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  await f.reopen();
  const status = JSON.parse((await f.tool("list", { id: cron.id })).text);
  expect(status.schedules[0].cron.timezone).toBe(expected);
  await f.tool("delete", { id: cron.id });
  expect(f.reports).toEqual([]);
});

test("普通 stop 和 reset 不取消独立后台计划，通知仍属于原会话", async () => {
  const f = await fixture();
  const schedule = await f.create("printf 'still scheduled'");
  await f.root.abort(context, { background: true });
  await f.root.reset(undefined, context);
  f.advance(1000);
  await f.run(schedule.id);
  expect((await f.notifications())[0]?.data.message).toBe("still scheduled");
});

test("只能管理所属会话的计划，删除直接停止等待中的计划并保留收据与日志", async () => {
  const f = await fixture();
  const schedule = await f.create("printf 'private'");
  const other = await f.harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model: { provider: "faux", modelId: "test" }, cwd: f.workspace },
    },
    context,
  );
  expect((await f.tool("list", { id: schedule.id }, other)).isError).toBe(true);
  expect((await f.tool("delete", { id: schedule.id }, other)).isError).toBe(
    true,
  );
  expect((await f.harness.getTask(schedule.id, context))?.abortRequested).toBe(
    false,
  );
  const removed = await f.tool("delete", { id: schedule.id });
  expect(removed.isError).toBe(false);
  expect(JSON.parse(removed.text)).toEqual({ id: schedule.id, deleted: true });
  expect(
    (await f.harness.getTask(schedule.id, context))?.state.outcome?.status,
  ).toBe("aborted");
  await f.reopen(10_000);
  expect(await f.notifications()).toHaveLength(0);
  expect(JSON.parse((await f.tool("list", {})).text)).toEqual({
    schedules: [],
  });
  expect(await f.harness.getTask(schedule.id, context)).toBeDefined();
  const completed = await f.create("printf 'saved'");
  f.advance(1000);
  const run = await f.run(completed.id);
  expect((await f.tool("delete", { id: completed.id })).isError).toBe(false);
  if (run.state.outcome.result && "stdoutPath" in run.state.outcome.result)
    expect(await readFile(run.state.outcome.result.stdoutPath, "utf8")).toBe(
      "saved",
    );
});

test("真实 bash 脚本使用创建时 cwd，目录不是沙箱", async () => {
  const f = await fixture();
  const cwd = join(f.workspace, "scripts");
  await mkdir(cwd);
  await writeFile(
    join(cwd, "check.sh"),
    'printf "from script\\n"; printf "script log\\n" >&2\n',
  );
  await f.root.configure({ cwd }, context);
  const schedule = await f.create("bash check.sh");
  f.advance(1000);
  const run = await f.run(schedule.id);
  expect((await f.notifications())[0]?.data.message).toBe("from script\n");
  const status = JSON.parse((await f.tool("list", { id: schedule.id })).text);
  expect(status.schedules[0].cwd).toBe(cwd);
  if (run.state.outcome.result && "stderrPath" in run.state.outcome.result)
    expect(await readFile(run.state.outcome.result.stderrPath, "utf8")).toBe(
      "script log\n",
    );
});

test("删除正在执行的脚本会等待进程终止，再移除登记且保留日志", async () => {
  const f = await fixture();
  const marker = join(f.workspace, "started");
  const schedule = await f.create(
    `printf once > ${JSON.stringify(marker + ".tmp")}; mv ${JSON.stringify(marker + ".tmp")} ${JSON.stringify(marker)}; sleep 9999`,
  );
  f.advance(1000);
  await exists(marker, f.workspace);
  const status = JSON.parse((await f.tool("list", { id: schedule.id })).text);
  expect((await f.tool("delete", { id: schedule.id })).isError).toBe(false);
  expect(
    (await f.harness.getTask(schedule.id, context))?.state.outcome?.status,
  ).toBe("aborted");
  expect(await f.notifications()).toHaveLength(0);
  expect(JSON.parse((await f.tool("list", {})).text)).toEqual({
    schedules: [],
  });
  expect((await stat(status.schedules[0].logs.stdoutPath)).isFile()).toBe(true);
  const runs = await f.harness.commit(
    (tx) => tx.scanTasks({ kind: "amadeus.schedule.run" }, 100),
    context,
  );
  expect(runs.items[0]?.state.outcome?.status).toBe("aborted");
  expect(f.reports).toEqual([]);
});

test.each(recurring)(
  "执行中关闭后不重放副作用，恢复报告不确定并停止周期 %j",
  async (when) => {
    const f = await fixture();
    const marker = join(f.workspace, "effect");
    const schedule = await f.create(
      `printf once >> ${JSON.stringify(marker)}; printf ready > ${JSON.stringify(marker + ".ready")}; sleep 9999`,
      when,
    );
    f.advance(1000);
    await exists(marker + ".ready", f.workspace);
    await f.reopen(5000);
    const run = await f.run(schedule.id);
    expect(run.state.outcome.result).toMatchObject({ status: "interrupted" });
    expect(await readFile(marker, "utf8")).toBe("once");
    expect(
      (await f.harness.getTask(schedule.id, context))?.state.outcome?.status,
    ).toBe("failed");
    expect((await f.notifications())[0]?.data.message).toContain(
      '"status":"interrupted"',
    );
    expect(f.reports).toEqual([]);
  },
);

test.each(recurring)(
  "周期执行失败仍按下一周期运行，stderr 不丢失且不添加即时重试 %j",
  async (when) => {
    const f = await fixture();
    const schedule = await f.create("printf 'failed check' >&2; exit 3", when);
    f.advance(1000);
    const first = await f.run(schedule.id);
    expect(await f.notifications()).toHaveLength(1);
    expect((await f.harness.getTask(schedule.id, context))?.state.status).toBe(
      "sleeping",
    );
    f.advance(1000);
    await f.run(schedule.id, first.id);
    expect(await f.notifications()).toHaveLength(2);
    await f.tool("delete", { id: schedule.id });
  },
);

test.each(recurring)(
  "同一周期计划不重叠，长任务期间错过的时段不会逐个补跑 %j",
  async (when) => {
    const f = await fixture();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch() {
        started.resolve();
        await release.promise;
        return new Response("ok");
      },
    });
    try {
      const script = `await fetch(${JSON.stringify(server.url.origin)}); process.stdout.write("finished");`;
      const schedule = await f.create(`bun -e ${JSON.stringify(script)}`, when);
      f.advance(1000);
      await started.promise;
      f.advance(4500);
      const running = await f.harness.commit(
        (tx) => tx.scanTasks({ kind: "amadeus.schedule.run" }, 100),
        context,
      );
      expect(running.items).toHaveLength(1);
      expect(await f.notifications()).toHaveLength(0);
      release.resolve();
      await f.run(schedule.id);
      expect(
        (await f.harness.getTask(schedule.id, context))?.state,
      ).toMatchObject({ status: "sleeping", until: 1_006_000 });
      await f.tool("delete", { id: schedule.id });
    } finally {
      release.resolve();
      await server.stop(true);
    }
  },
);

test("日志目录符号链接拒绝写入，原始错误由原生任务报告并通知", async () => {
  const f = await fixture();
  const target = join(f.directory, "keep");
  await mkdir(target);
  await writeFile(join(target, "data"), "unchanged");
  await symlink(target, join(f.directory, "schedules"));
  const schedule = await f.create("printf 'must not execute'");
  f.advance(1000);
  const run = await f.run(schedule.id);
  expect(run.state.outcome.status).toBe("faulted");
  expect(f.reports[0]).toBeInstanceOf(z.ZodError);
  expect(await readFile(join(target, "data"), "utf8")).toBe("unchanged");
  expect(await f.notifications()).toHaveLength(1);
});

test("完成工具即使被显式加载，也拒绝没有 Worker 运行归属的主会话", async () => {
  const f = await fixture();
  await f.root.configure({ modelTools: { add: [ScheduleResult] } }, context);
  f.faux.setResponses([
    complete({ notify: true, message: "不得发送" }),
    fauxAssistantMessage("rejected"),
  ]);
  await (
    await f.root.submit({ type: "input", content: "尝试越权完成" }, context)
  ).wait(context);
  await f.root.waitForIdle(context);
  const entries = await f.root.entries({}, 100, undefined, context);
  const result = entries.items
    .filter(ToolResultEntry.is)
    .flatMap((entry) => entry.model ?? [])
    .find((message) => message.role === "toolResult");
  expect(result?.role === "toolResult" && result.isError).toBe(true);
  expect(
    await f.harness.snapshot(ScheduleWorker, f.root.id, context),
  ).toBeUndefined();
  expect(await f.notifications()).toHaveLength(0);
});

test("只暴露单一 schedule 工具，所有动作保守恢复且按动作校验参数", async () => {
  const f = await fixture();
  const tools = f.registry
    .snapshot()
    .tools()
    .map(({ tool }) => tool);
  expect(
    tools.filter(({ deferred }) => !deferred).map(({ name }) => name),
  ).toEqual(["schedule"]);
  expect(tools.find(({ name }) => name === "schedule_result")).toMatchObject({
    deferred: true,
    callers: ["model"],
    replay: "safe",
  });
  expect(tools[0]?.replay).toBe("unsafe");
  for (const [action, args] of [
    [
      "create",
      { name: "missing command", when: { kind: "after", delayMs: 0 } },
    ],
    [
      "create",
      {
        name: "both",
        command: "true",
        prompt: "goal",
        when: { kind: "after", delayMs: 0 },
      },
    ],
    [
      "create",
      { name: "empty", prompt: "  ", when: { kind: "after", delayMs: 0 } },
    ],
    ["delete", {}],
    ["list", { command: "must not run" }],
    ["cancel", { id: 1 }],
  ] satisfies [string, JsonObject][]) {
    expect((await f.tool(action, args)).isError).toBe(true);
  }
  expect(JSON.parse((await f.tool("list", {})).text)).toEqual({
    schedules: [],
  });
});

test("时间参数和当前会话权限沿用原生 schema 与 Zod 错误", async () => {
  const f = await fixture();
  for (const when of [
    { kind: "every", intervalMs: 0 },
    { kind: "after", delayMs: -1 },
    { kind: "at", at: "tomorrow" },
    { kind: "cron", expression: "   " },
    { kind: "cron", expression: "70 * * * *", timezone: "UTC" },
    { kind: "cron", expression: "* * * * *", timezone: "Not/A_Timezone" },
  ]) {
    expect(
      (
        await f.tool("create", {
          name: "invalid",
          command: "printf bad",
          when,
        })
      ).isError,
    ).toBe(true);
  }
  expect(JSON.parse((await f.tool("list", {})).text)).toEqual({
    schedules: [],
  });
});
