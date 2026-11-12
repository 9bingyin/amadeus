import { afterEach, expect, spyOn, test } from "bun:test";
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
  type ConversationId,
  type JsonObject,
  type Task,
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
  readdir,
  rename,
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
} from "../../channels/notifications";
import { createSchedulesExtension, Schedules } from ".";
import { ScheduleResult, ScheduleWorker } from "./loop";
import { createScheduleFile, readScheduleFile } from "./files";

const context = BACKGROUND_CONTEXT;
const recurring: JsonObject[] = [
  { kind: "every", intervalMs: 1000 },
  { kind: "cron", expression: "* * * * * *", timezone: "UTC" },
];
type ControllerTask = Task<
  { owner: ConversationId; firstAt: number },
  { phase: "wait"; at: number } | { phase: "collect"; at: number; run: TaskId },
  null,
  object
>;
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
    createSchedulesExtension(
      directory,
      (id, context) => harness.abortTask(id, context),
      (id, context) => harness.submission(id, context),
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
      .object({ id: z.int().positive(), path: z.string(), nextAt: z.int() })
      .parse(JSON.parse(result.text));
    // The create result contains a validated native task ID.
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
    // The wait above established that the catalog contains this run.
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

test.each(["script", "agent"])(
  "Saves the %s definition as private JSON, not catalog content",
  async (kind) => {
    const f = await fixture(1_000_000, () => fauxAssistantMessage("done"));
    const execution =
      kind === "script" ? "printf original" : { prompt: "Original goal" };
    const plan = await f.create(execution, {
      kind: "cron",
      expression: "0 * * * *",
      timezone: "UTC",
    });
    expect(plan.path).toBe(
      join(f.directory, "schedules", String(plan.id), "plan.json"),
    );
    const definition = await readScheduleFile(plan.path);
    expect(definition).toEqual({
      name: "test schedule",
      cwd: f.workspace,
      ...(typeof execution === "string" ? { command: execution } : execution),
      when: { kind: "cron", expression: "0 * * * *", timezone: "UTC" },
    });
    const catalog = await f.harness.snapshot(Schedules, f.root.id, context);
    expect(Object.keys(catalog?.jobs[plan.id] ?? {}).sort()).toEqual(
      kind === "script" ? ["lastRun"] : ["lastRun", "worker"],
    );
    expect((await stat(plan.path)).mode & 0o777).toBe(0o600);
    expect(
      (await stat(join(f.directory, "schedules", String(plan.id)))).mode &
        0o777,
    ).toBe(0o700);
    expect((await stat(join(f.directory, "schedules"))).mode & 0o777).toBe(
      0o700,
    );
    const listed = JSON.parse((await f.tool("list", { id: plan.id })).text);
    expect(listed.schedules[0]).toMatchObject({
      path: plan.path,
      name: definition.name,
      cwd: f.workspace,
    });
    await f.tool("delete", { id: plan.id });
    expect(await readScheduleFile(plan.path)).toEqual(definition);
  },
);

test("Rereads edited script content, cwd and timing without moving an existing sleep", async () => {
  const f = await fixture();
  const plan = await f.create("printf original", {
    kind: "every",
    intervalMs: 1000,
  });
  const cwd = join(f.workspace, "changed");
  await mkdir(cwd);
  await writeFile(
    plan.path,
    JSON.stringify({
      name: "Edited script",
      command: "printf 'edited:'; pwd",
      cwd: "../../work space/changed",
      when: { kind: "every", intervalMs: 5000 },
    }),
  );
  await f.reopen(500);
  const waiting = await until(
    f.harness,
    () => f.harness.getTask(plan.id, context),
    (task) => task?.state.status === "sleeping",
  );
  expect(waiting?.state).toMatchObject({ until: 1_001_000 });
  expect(await f.notifications()).toHaveLength(0);
  f.advance(500);
  const first = await f.run(plan.id);
  expect(first.input).toEqual({ schedule: plan.id });
  expect((await f.notifications())[0]?.data.message).toBe(`edited:${cwd}\n`);
  expect((await f.notifications())[0]?.data.metadata?.["name"]).toBe(
    "Edited script",
  );
  expect((await f.harness.getTask(plan.id, context))?.state).toMatchObject({
    status: "sleeping",
    until: 1_006_000,
  });
  await writeFile(
    plan.path,
    JSON.stringify({
      ...(await readScheduleFile(plan.path)),
      command: "printf latest",
    }),
  );
  f.advance(5000);
  await f.run(plan.id, first.id);
  expect((await f.notifications())[1]?.data.message).toBe("latest");
  const listed = JSON.parse((await f.tool("list", { id: plan.id })).text);
  expect(listed.schedules[0]).toMatchObject({
    name: "Edited script",
    command: "printf latest",
    cwd,
    intervalMs: 5000,
  });
  expect(f.reports).toEqual([]);
});

test("Reads the latest Agent prompt and cwd for each run while retaining worker history", async () => {
  let round = 0;
  const f = await fixture(1_000_000, () =>
    fauxAssistantMessage(`answer ${++round}`),
  );
  const plan = await f.create(
    { prompt: "Original goal" },
    { kind: "every", intervalMs: 1000 },
  );
  const cwd = join(f.workspace, "worker");
  await mkdir(cwd);
  await writeFile(
    plan.path,
    JSON.stringify({
      ...(await readScheduleFile(plan.path)),
      prompt: "Current goal",
      cwd: "../../work space/worker",
    }),
  );
  f.advance(1000);
  const first = await f.run(plan.id);
  expect(first.input).toEqual({ worker: expect.any(Number), path: plan.path });
  expect(
    contentText(
      f.workerRequests[0]?.messages.findLast(
        (message) => message.role === "user",
      )?.content ?? [],
    ),
  ).toBe("Current goal");
  const workerId = (await f.harness.snapshot(Schedules, f.root.id, context))
    ?.jobs[plan.id]?.worker;
  if (!workerId) return z.never().parse(workerId);
  const worker = await f.harness.conversation(workerId, context);
  expect((await worker?.agent(context))?.cwd).toBe(cwd);
  await writeFile(
    plan.path,
    JSON.stringify({
      ...(await readScheduleFile(plan.path)),
      prompt: "Next goal",
    }),
  );
  f.advance(1000);
  await f.run(plan.id, first.id);
  expect(
    contentText(
      f.workerRequests[1]?.messages.findLast(
        (message) => message.role === "user",
      )?.content ?? [],
    ),
  ).toBe("Next goal");
  expect(
    f.workerRequests[1]?.messages.some(
      (message) =>
        message.role === "assistant" &&
        contentText(message.content) === "answer 1",
    ),
  ).toBe(true);
  expect(f.workerRequests).toHaveLength(2);
  expect(await f.notifications()).toHaveLength(0);
  expect(f.reports).toEqual([]);
});

test.each(["invalid", "missing", "wrong runner"])(
  "Stops before execution when the definition is %s",
  async (kind) => {
    const f = await fixture();
    const marker = join(f.workspace, "must-not-execute");
    const command = `printf unsafe > ${JSON.stringify(marker)}`;
    const plan = await f.create(command, { kind: "every", intervalMs: 1000 });
    if (kind === "missing") {
      await f.harness.commit(async (tx) => {
        const catalog = await tx.doc(Schedules, f.root.id);
        const legacy = {
          name: "legacy",
          command,
          cwd: f.workspace,
          intervalMs: 1000,
          lastRun: null,
        };
        catalog.jobs[plan.id] = legacy;
      }, context);
      await rm(plan.path);
      await f.reopen();
    } else if (kind === "invalid") await writeFile(plan.path, "{");
    else
      await writeFile(
        plan.path,
        JSON.stringify({
          name: "changed type",
          cwd: f.workspace,
          prompt: "must not execute",
          when: { kind: "every", intervalMs: 1000 },
        }),
      );
    f.advance(1000);
    const run = await f.run(plan.id);
    expect(run.state.outcome.status).toBe("faulted");
    expect(
      (await f.harness.getTask(plan.id, context))?.state.outcome?.status,
    ).toBe("failed");
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await f.notifications()).toHaveLength(1);
    if (kind === "invalid") expect(f.reports[0]).toBeInstanceOf(SyntaxError);
    else if (kind === "wrong runner")
      expect(f.reports[0]).toBeInstanceOf(z.ZodError);
    else {
      expect(f.reports[0]).toMatchObject({ code: "ENOENT", path: plan.path });
      expect(await Bun.file(plan.path).exists()).toBe(false);
    }
    expect((await f.tool("delete", { id: plan.id })).isError).toBe(false);
  },
);

test.each(["file", "directory"])(
  "Rejects a replacement definition %s symlink without following it",
  async (kind) => {
    const f = await fixture();
    const marker = join(f.workspace, "must-not-execute");
    const plan = await f.create(`printf unsafe > ${JSON.stringify(marker)}`);
    const original = await readFile(plan.path, "utf8");
    const target = join(f.directory, "keep");
    if (kind === "file") await rename(plan.path, target);
    else await rename(join(f.directory, "schedules", String(plan.id)), target);
    await symlink(
      target,
      kind === "file"
        ? plan.path
        : join(f.directory, "schedules", String(plan.id)),
    );
    f.advance(1000);
    const run = await f.run(plan.id);
    expect(run.state.outcome.status).toBe("faulted");
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(
      await readFile(
        kind === "file" ? target : join(target, "plan.json"),
        "utf8",
      ),
    ).toBe(original);
    if (kind === "file") expect(f.reports[0]).toMatchObject({ code: "ELOOP" });
    else expect(f.reports[0]).toBeInstanceOf(z.ZodError);
    expect(await f.notifications()).toHaveLength(1);
  },
);

test("Reports invalid edits made during execution and stops future scheduling", async () => {
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
    const command = `await fetch(${JSON.stringify(server.url.origin)}); process.stdout.write("original report");`;
    const plan = await f.create(`bun -e ${JSON.stringify(command)}`, {
      kind: "every",
      intervalMs: 1000,
    });
    f.advance(1000);
    await started.promise;
    await writeFile(plan.path, "{");
    release.resolve();
    const run = await f.run(plan.id);
    expect(run.state.outcome.status).toBe("completed");
    expect(
      (await f.harness.getTask(plan.id, context))?.state.outcome?.status,
    ).toBe("failed");
    const notifications = await f.notifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.data.message).toContain("original report");
    expect(f.reports[0]).toBeInstanceOf(SyntaxError);
    if (!(f.reports[0] instanceof SyntaxError))
      return z.never().parse(f.reports[0]);
    expect(notifications[0]?.data.message).toContain(f.reports[0].message);
    expect((await f.tool("delete", { id: plan.id })).isError).toBe(false);
  } finally {
    release.resolve();
    await server.stop(true);
  }
});

test("Publishes complete plan JSON exclusively without overwriting or leaving temporary files", async () => {
  const f = await fixture();
  const plan = await f.create("printf original");
  const original = await readFile(plan.path, "utf8");
  await expect(
    createScheduleFile(
      f.directory,
      plan.id,
      { ...(await readScheduleFile(plan.path)), name: "replacement" },
      context,
    ),
  ).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(plan.path, "utf8")).toBe(original);
  expect(
    await readdir(join(f.directory, "schedules", String(plan.id))),
  ).toEqual(["plan.json"]);
});

test("Runs scheduled agents without notifying for handled tool errors", async () => {
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
    prompt: "Handle check errors and stay silent unless attention is needed.",
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

test("Reuses worker history across restart and reports only meaningful changes", async () => {
  let runs = 0;
  const f = await fixture(1_000_000, (request) => {
    const index = runs++;
    if (index === 0)
      return fauxAssistantMessage("Baseline recorded; no attention needed.");
    if (index === 2)
      return fauxAssistantMessage("The reported issue is unchanged.");
    expect(
      request.messages.some(
        (message) =>
          message.role === "assistant" &&
          contentText(message.content) ===
            "Baseline recorded; no attention needed.",
      ),
    ).toBe(true);
    return complete({ notify: true, message: "A new issue needs attention." });
  });
  const plan = await f.create(
    { prompt: "Compare with the previous state and report only new changes." },
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
    "A new issue needs attention.",
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

test("Ends ordinary worker answers silently without requiring a result tool", async () => {
  let round = 0;
  const answer = "Check completed; no attention needed.";
  const f = await fixture(1_000_000, () => {
    expect(++round).toBe(1);
    return fauxAssistantMessage(answer);
  });
  const plan = await f.create({ prompt: "Check and finish" });
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

test("Reports original worker failures and resumes on the next interval", async () => {
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
    { prompt: "Check" },
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

test("Deletes workers and child tools without coupling plans to chat reset", async () => {
  const f = await fixture(1_000_000, () =>
    fauxAssistantMessage(
      fauxToolCall("bash", {
        command: `printf ready > ${JSON.stringify(marker + ".tmp")}; mv ${JSON.stringify(marker + ".tmp")} ${JSON.stringify(marker)}; sleep 9999`,
      }),
      { stopReason: "toolUse" },
    ),
  );
  const marker = join(f.workspace, "worker-started");
  const plan = await f.create({ prompt: "Run a long check" });
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

test("Resumes a worker submission without replaying unsafe side effects", async () => {
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
    return complete({
      notify: true,
      message: "Execution interrupted; verify existing effects.",
    });
  });
  const marker = join(f.workspace, "worker-effect");
  const plan = await f.create({ prompt: "Run and verify" });
  f.advance(1000);
  await exists(marker + ".ready", f.workspace);
  const before = (await f.harness.snapshot(Schedules, f.root.id, context))
    ?.jobs[plan.id]?.lastRun;
  if (!before) return z.never().parse(before);
  await writeFile(
    plan.path,
    JSON.stringify({
      ...(await readScheduleFile(plan.path)),
      prompt: "Changed task for a future run",
    }),
  );
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
  expect(
    f.workerRequests
      .flatMap((request) => request.messages)
      .some(
        (message) =>
          message.role === "user" &&
          contentText(message.content).includes(
            "Changed task for a future run",
          ),
      ),
  ).toBe(false);
  expect(f.reports).toEqual([]);
});

test("Replays a saved report decision without duplicate notifications", async () => {
  const f = await fixture(1_000_000, () =>
    complete({ notify: true, message: "Finish the report" }),
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
  const plan = await f.create({ prompt: "Check and report" });
  f.advance(1000);
  await saved.promise;
  await f.reopen();
  await f.run(plan.id);
  expect(f.workerRequests).toHaveLength(1);
  expect(await f.notifications()).toHaveLength(1);
  expect((await f.notifications())[0]?.data.message).toBe("Finish the report");
  expect(f.reports).toEqual([]);
});

test.each([false, true])(
  "Waits for worker afterRun before the next period, notify=%s",
  async (notify) => {
    const f = await fixture(1_000_000, () =>
      notify
        ? complete({ notify: true, message: "Report after cleanup" })
        : fauxAssistantMessage("Check completed."),
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
      { prompt: "Check" },
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

test("Reports nonblank stdout and keeps stderr in script logs", async () => {
  const f = await fixture();
  for (const [command, count] of [
    ["printf 'routine log\\n' >&2", 0],
    ["printf '  \\n\\t'; printf 'another log' >&2", 0],
    ["printf 'Needs attention\\n'; printf 'diagnostic only' >&2", 1],
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
  expect(report?.data.message).toBe("Needs attention\n");
  expect(report?.data.data).toMatchObject({ kind: "schedule" });
  expect(report?.data.metadata).toMatchObject({
    source: "schedule",
    name: "test schedule",
    runner: "command",
  });
  expect(f.reports).toEqual([]);
});

test("Reports the original script failure once with its exit code and logs", async () => {
  const f = await fixture();
  const schedule = await f.create(
    "printf 'partial report'; printf 'Original error\\n' >&2; exit 7",
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
    expect(await readFile(result.stderrPath, "utf8")).toBe("Original error\n");
    expect((await stat(result.stdoutPath)).mode & 0o777).toBe(0o600);
  }
  expect((await f.notifications())[0]?.data.message).toBe("Original error\n");
  expect(
    (await f.harness.getTask(schedule.id, context))?.state.outcome?.status,
  ).toBe("failed");
  await f.reopen(10000);
  await f.root.waitForIdle(context);
  expect(await f.notifications()).toHaveLength(1);
});

test("Preserves deadlines and coalesces missed fixed intervals after restart", async () => {
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

test("Distinguishes interval, Cron, and one-time deadlines across restart", async () => {
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

test("Preserves the Cron timezone through DST and restart", async () => {
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

test("Saves the host timezone when creating a Cron plan", async () => {
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

test("Keeps independent plans alive after chat stop and reset", async () => {
  const f = await fixture();
  const schedule = await f.create("printf 'still scheduled'");
  await f.root.abort(context, { background: true });
  await f.root.reset(undefined, context);
  f.advance(1000);
  await f.run(schedule.id);
  expect((await f.notifications())[0]?.data.message).toBe("still scheduled");
});

test("Restricts plan management to its owner and retains receipts after deletion", async () => {
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

test("Runs scripts in the saved cwd without treating it as a sandbox", async () => {
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

test("Does not create a run when deletion wins the wake-up commit", async () => {
  const f = await fixture();
  const plan = await f.create("printf report", {
    kind: "every",
    intervalMs: 1000,
  });
  await until(
    f.harness,
    () => f.harness.getTask(plan.id, context),
    (task) => task?.state.status === "sleeping",
  );
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  // Registry erases task generics; this name belongs to the schedule controller.
  const controller = f.registry
    .snapshot()
    .task("amadeus.schedule") as ControllerTask;
  const wait = controller.definition.phases.wait;
  const blocked = spyOn(
    controller.definition.phases,
    "wait",
  ).mockImplementation(async (task, runtime, ctx) => {
    const commit = runtime.commit.bind(runtime);
    const checkpoint = spyOn(runtime, "commit").mockImplementationOnce(
      async (change, commitContext, options) => {
        entered.resolve();
        await release.promise;
        return commit(change, commitContext, options);
      },
    );
    try {
      return await wait(task, runtime, ctx);
    } finally {
      checkpoint.mockRestore();
    }
  });
  let deleting: ReturnType<typeof f.tool> | undefined;
  try {
    f.advance(1000);
    await entered.promise;
    deleting = f.tool("delete", { id: plan.id });
    await until(
      f.harness,
      () => f.harness.getTask(plan.id, context),
      (task) => task?.abortRequested === true,
    );
    expect(
      (await f.harness.snapshot(Schedules, f.root.id, context))?.jobs[plan.id],
    ).toBeDefined();
    release.resolve();
    expect((await deleting).isError).toBe(false);
    f.advance(10_000);
    const runs = await f.harness.commit(
      (tx) => tx.scanTasks({ kind: "amadeus.schedule.run" }, 10),
      context,
    );
    expect(runs.items).toHaveLength(0);
    expect(
      (await f.harness.snapshot(Schedules, f.root.id, context))?.jobs[plan.id],
    ).toBeUndefined();
    expect(await f.notifications()).toHaveLength(0);
    expect(f.reports).toEqual([]);
  } finally {
    release.resolve();
    await deleting;
    blocked.mockRestore();
  }
});

test("Does not publish a prepared result when deletion wins the collection commit", async () => {
  const f = await fixture();
  const plan = await f.create("printf report", {
    kind: "every",
    intervalMs: 1000,
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  // Registry erases task generics; this name belongs to the schedule controller.
  const controller = f.registry
    .snapshot()
    .task("amadeus.schedule") as ControllerTask;
  const collect = controller.definition.phases.collect;
  const blocked = spyOn(
    controller.definition.phases,
    "collect",
  ).mockImplementation(async (task, runtime, ctx) => {
    const commit = runtime.commit.bind(runtime);
    const checkpoint = spyOn(runtime, "commit").mockImplementationOnce(
      async (change, commitContext, options) => {
        entered.resolve();
        await release.promise;
        return commit(change, commitContext, options);
      },
    );
    try {
      return await collect(task, runtime, ctx);
    } finally {
      checkpoint.mockRestore();
    }
  });
  let deleting: ReturnType<typeof f.tool> | undefined;
  try {
    f.advance(1000);
    await entered.promise;
    const runs = await f.harness.commit(
      (tx) => tx.scanTasks({ kind: "amadeus.schedule.run" }, 10),
      context,
    );
    expect(runs.items).toHaveLength(1);
    expect(runs.items[0]?.state.outcome?.status).toBe("completed");
    deleting = f.tool("delete", { id: plan.id });
    await until(
      f.harness,
      () => f.harness.getTask(plan.id, context),
      (task) => task?.abortRequested === true,
    );
    release.resolve();
    expect((await deleting).isError).toBe(false);
    f.advance(10_000);
    const notifications = await f.harness.commit(
      (tx) => tx.scanTasks({ kind: NotificationTask.definition.name }, 10),
      context,
    );
    expect(notifications.items).toHaveLength(0);
    expect(
      (await f.harness.snapshot(Schedules, f.root.id, context))?.jobs[plan.id],
    ).toBeUndefined();
    expect(f.reports).toEqual([]);
  } finally {
    release.resolve();
    await deleting;
    blocked.mockRestore();
  }
});

test("Keeps an already accepted report when its plan is deleted", async () => {
  const f = await fixture();
  const plan = await f.create("printf report", {
    kind: "every",
    intervalMs: 1000,
  });
  const entered = Promise.withResolvers<TaskId<null>>();
  const release = Promise.withResolvers<void>();
  const submit = NotificationTask.definition.phases.submit;
  const blocked = spyOn(
    NotificationTask.definition.phases,
    "submit",
  ).mockImplementation(async (task, runtime, ctx) => {
    entered.resolve(task.id);
    await release.promise;
    return submit(task, runtime, ctx);
  });
  try {
    f.advance(1000);
    const notification = await entered.promise;
    expect((await f.tool("delete", { id: plan.id })).isError).toBe(false);
    expect(
      (await f.harness.getTask(notification, context))?.abortRequested,
    ).toBe(false);
    expect(await f.notifications()).toHaveLength(0);
    release.resolve();
    await f.harness.waitForTask(notification, context);
    await f.root.waitForIdle(context);
    expect(
      (await f.notifications()).map((entry) => entry.data.message),
    ).toEqual(["report"]);
    expect(
      (await f.harness.snapshot(Schedules, f.root.id, context))?.jobs[plan.id],
    ).toBeUndefined();
    expect(f.reports).toEqual([]);
  } finally {
    release.resolve();
    blocked.mockRestore();
  }
});

test("Waits for a running script to stop before deleting its plan", async () => {
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
  "Stops an uncertain script after restart without replaying effects: %j",
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
  "Reports stderr and waits for the next period after script failure: %j",
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
  "Serializes runs and coalesces periods missed during long work: %j",
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

test("Rejects a symlinked schedule root before registering a plan", async () => {
  const f = await fixture();
  const target = join(f.directory, "keep");
  await mkdir(target);
  await writeFile(join(target, "data"), "unchanged");
  await symlink(target, join(f.directory, "schedules"));
  const result = await f.tool("create", {
    name: "blocked",
    command: "printf 'must not execute'",
    when: { kind: "after", delayMs: 1000 },
  });
  expect(result.isError).toBe(true);
  expect(
    (await f.harness.snapshot(Schedules, f.root.id, context))?.jobs ?? {},
  ).toEqual({});
  expect(await readFile(join(target, "data"), "utf8")).toBe("unchanged");
  expect(await readdir(target)).toEqual(["data"]);
  expect(await f.notifications()).toHaveLength(0);
});

test("Rejects schedule_result outside an active worker run", async () => {
  const f = await fixture();
  await f.root.configure({ modelTools: { add: [ScheduleResult] } }, context);
  f.faux.setResponses([
    complete({ notify: true, message: "Must not send" }),
    fauxAssistantMessage("rejected"),
  ]);
  await (
    await f.root.submit(
      { type: "input", content: "Attempt unauthorized completion" },
      context,
    )
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

test("Exposes one unsafe schedule tool with action-specific arguments", async () => {
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

test("Preserves native schedule validation and ownership errors", async () => {
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
