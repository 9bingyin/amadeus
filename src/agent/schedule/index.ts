import type { Context } from "@earendil-works/chord/context";
import {
  defineExtension,
  defineTool,
  section,
  type Harness,
} from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import {
  arr,
  bool,
  int,
  lit,
  nullable,
  obj,
  opt,
  str,
  union,
  unknown,
} from "@earendil-works/pi-schema";
import { z } from "zod";
import {
  createPlan,
  firstAt,
  metaPath,
  newPlanId,
  planIdSchema,
  readPlanMeta,
  readScheduleFile,
  scanPlans,
  scheduleDefinitionSchema,
  schedulePath,
  writePlanMeta,
  type PlanId,
  type PlanMeta,
} from "./files";
import {
  ScheduleLoopPrompt,
  ScheduleResult,
  ScheduleWorker,
  workerExcludedExtensions,
  workerExcludedTools,
} from "./loop";
import {
  controllerRecords,
  createPlanLock,
  listSchedules,
  observeControllers,
  ownedMeta,
  ownerId,
  type ControllerInput,
  type ControllerIndex,
  type ControllerRecord,
} from "./runtime";
import { createScheduleTasks, runPaths } from "./tasks";

export { listSchedules } from "./runtime";
function reply(value: unknown) {
  const data = z.json().parse(value);
  return {
    output: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredOutput: data,
  };
}
function phase(task: ControllerRecord) {
  if (task.state.status === "terminal" || task.state.status === "completing")
    return;
  const checkpoint = task.state.checkpoint;
  return typeof checkpoint === "object" &&
    checkpoint !== null &&
    !Array.isArray(checkpoint)
    ? checkpoint["phase"]
    : undefined;
}
function completedOneShot(task: ControllerRecord) {
  if (task.state.status !== "terminal" && task.state.status !== "completing")
    return false;
  const result = task.state.outcome.result;
  return (
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result) &&
    result["reason"] === "completed"
  );
}
export function createSchedulesExtension(home: string, harness: () => Harness) {
  const withPlan = createPlanLock();
  const { Controller, tasks } = createScheduleTasks(home, harness, withPlan);
  async function records(
    id: PlanId,
    context: Context,
    index?: ControllerIndex,
  ) {
    if (index) return index.get(id);
    return (await controllerRecords(harness(), context)).filter(
      (task) => task.input.planId === id,
    );
  }
  async function register(
    id: PlanId,
    meta: PlanMeta,
    context: Context,
    index?: ControllerIndex,
  ) {
    const all = index ? [] : await controllerRecords(harness(), context);
    const own =
      index?.get(id) ?? all.filter((task) => task.input.planId === id);
    const existing = own.findLast(
      (task) => task.input.activation === meta.activation,
    );
    if (existing) return existing.id;
    // 已登记却找不到原生记录时，不能把未知执行结果当作新计划自动重跑。
    z.literal(false).parse(meta.registered);
    const definition = await readScheduleFile(schedulePath(home, id));
    const before = own
      .filter((task) => task.state.status !== "terminal")
      .map(({ id }) => id);
    let history = null;
    if ("prompt" in definition) {
      for (const task of own.toReversed()) {
        if (
          (
            await harness().commit(
              (tx) => tx.scanConversations({ ownerTaskId: task.id }, 1),
              context,
            )
          ).items.length
        ) {
          history = task.id;
          break;
        }
      }
    }
    const host = index?.host ?? all.at(-1)?.conversationId;
    return harness().commit(async (tx) => {
      if (!(await tx.conversation(ownerId(meta))))
        return z.never().parse(meta.owner);
      const conversationId =
        host ??
        (await tx.createConversation({ ownership: { kind: "ownerless" } })).id;
      return tx.createTask(
        Controller,
        {
          planId: id,
          activation: meta.activation,
          owner: ownerId(meta),
          firstAt: firstAt(definition, meta.activatedAt),
          before,
          history,
          runner: "prompt" in definition ? "agent" : "command",
        } satisfies ControllerInput,
        {
          ownership: { kind: "conversation" },
          conversationId,
          background: true,
        },
      );
    }, context);
  }
  async function reconcile(
    id: PlanId,
    context: Context,
    index?: ControllerIndex,
  ) {
    const settle = await withPlan(id, context, async () => {
      let meta = await readPlanMeta(home, id);
      const completed = index
        ?.get(id)
        .findLast((task) => task.input.activation === meta.activation);
      if (
        meta.status !== "deleted" &&
        completed &&
        completedOneShot(completed)
      ) {
        z.literal(completed.input.owner).parse(meta.owner);
        meta = { ...meta, status: "deleted" };
        await writePlanMeta(home, id, meta, context);
      }
      if (meta.status === "enabled") {
        await register(id, meta, context, index);
        return [];
      }
      return (await records(id, context, index)).flatMap((task) => {
        if (task.state.status === "terminal") return [];
        const checkpoint = phase(task);
        if (checkpoint === "finish" || completedOneShot(task))
          return [{ id: task.id, cancel: false }];
        return meta.status === "deleted" || checkpoint !== "collect"
          ? [{ id: task.id, cancel: true }]
          : [];
      });
    });
    // 原生取消会等待持有同一计划锁的运行收尾，不能在锁内等待。
    for (const task of settle) {
      if (task.cancel) await harness().abortTask(task.id, context);
      await harness().waitForTask(task.id, context);
    }
  }
  const statusSchema = union([lit("enabled"), lit("disabled"), lit("deleted")]);
  const whenSchema = union([
    obj({
      kind: lit("after"),
      delayMs: int({
        minimum: 0,
        description: "One-time delay in milliseconds.",
      }),
    }),
    obj({
      kind: lit("at"),
      at: str({
        format: "date-time",
        description: "ISO timestamp with UTC offset; runs once.",
      }),
    }),
    obj({
      kind: lit("every"),
      intervalMs: int({
        minimum: 1,
        description:
          "Milliseconds between runs; first run after this interval.",
      }),
    }),
    obj({
      kind: lit("cron"),
      expression: str({
        minLength: 1,
        pattern: "\\S",
        description: "Five fields, or six with leading seconds.",
      }),
      timezone: opt(
        str({
          minLength: 1,
          description:
            "IANA timezone; saved explicitly, defaults to the host timezone.",
        }),
      ),
    }),
  ]);
  const idSchema = str({
    format: "uuid",
    description: "Stable plan UUID, not a Durable task ID.",
  });
  const createFields = {
    action: lit("create"),
    name: str({ minLength: 1 }),
    when: whenSchema,
    cwd: opt(
      str({
        minLength: 1,
        description:
          "Defaults to current cwd; relative paths resolve there. Not a sandbox.",
      }),
    ),
    status: opt(union([lit("enabled"), lit("disabled")])),
  };
  const schedule = defineTool({
    name: "schedule",
    description:
      "Manage this conversation's file-backed plans. Create, list, enable, disable after the current run, or permanently soft-delete and cancel. After an interrupted call, list before retrying changes.",
    parameters: {
      type: "object",
      ...union([
        obj({ ...createFields, command: str({ minLength: 1 }) }),
        obj({
          ...createFields,
          prompt: str({
            minLength: 1,
            pattern: "\\S",
            description:
              "Self-contained Agent task and reporting conditions; earlier runs are retained.",
          }),
        }),
        obj({
          action: lit("list"),
          id: opt(idSchema),
          includeDeleted: opt(
            bool({
              description: "Include deleted plans in the directory listing.",
            }),
          ),
        }),
        obj({ action: lit("enable"), id: idSchema }),
        obj({ action: lit("disable"), id: idSchema }),
        obj({ action: lit("delete"), id: idSchema }),
      ]),
    },
    structuredOutputSchema: union([
      obj({
        id: str(),
        status: statusSchema,
        path: str(),
        metaPath: str(),
        nextAt: nullable(int()),
      }),
      obj({
        schedules: arr(
          obj({
            id: str(),
            status: statusSchema,
            name: str(),
            path: str(),
            metaPath: str(),
            cwd: str(),
            command: nullable(str()),
            prompt: nullable(str()),
            when: whenSchema,
            controller: nullable(int()),
            worker: nullable(int()),
            state: unknown(),
            lastRun: unknown(),
            runId: nullable(int()),
            logs: nullable(obj({ stdoutPath: str(), stderrPath: str() })),
          }),
        ),
      }),
      obj({ id: str(), status: statusSchema }),
    ]),
    replay: "unsafe",
    executionMode: "sequential",
    async execute(args, api, context) {
      if (args.action === "list") {
        const schedules = await listSchedules(
          home,
          harness(),
          api.conversationId,
          context,
          {
            ...(args.id === undefined
              ? {}
              : { id: planIdSchema.parse(args.id) }),
            ...(args.includeDeleted === undefined
              ? {}
              : { includeDeleted: args.includeDeleted }),
          },
        );
        return reply({
          schedules: schedules.map(
            ({ id, meta, definition, path, controller, run }) => {
              const input = run?.input;
              const worker =
                input &&
                typeof input === "object" &&
                !Array.isArray(input) &&
                typeof input["worker"] === "number"
                  ? input["worker"]
                  : null;
              const files =
                run?.kind === "amadeus.schedule.run"
                  ? runPaths(home, id, run.id)
                  : null;
              return {
                id,
                status: meta.status,
                name: definition.name,
                path,
                metaPath: metaPath(home, id),
                cwd: definition.cwd,
                command: "command" in definition ? definition.command : null,
                prompt: "prompt" in definition ? definition.prompt : null,
                when: definition.when,
                controller: controller?.id ?? null,
                worker,
                state: controller?.state ?? null,
                lastRun: run?.state ?? null,
                runId: run?.id ?? null,
                logs: files
                  ? {
                      stdoutPath: files.stdoutPath,
                      stderrPath: files.stderrPath,
                    }
                  : null,
              };
            },
          ),
        });
      }
      if (args.action !== "create") {
        const id = planIdSchema.parse(args.id);
        const status =
          args.action === "delete"
            ? "deleted"
            : args.action === "disable"
              ? "disabled"
              : "enabled";
        await withPlan(id, context, async () => {
          const meta = await ownedMeta(home, id, api.conversationId);
          if (meta.status === "deleted") {
            z.literal("deleted").parse(status);
            return;
          }
          if (meta.status === status) return;
          await writePlanMeta(
            home,
            id,
            {
              ...meta,
              status,
              ...(status === "enabled"
                ? {
                    activation: meta.activation + 1,
                    activatedAt: api.now(),
                    registered: false,
                  }
                : {}),
            },
            context,
          );
        });
        await reconcile(id, context);
        const current = await ownedMeta(home, id, api.conversationId);
        console.info(
          `Schedule status changed: conversation=${api.conversationId} schedule=${id} status=${current.status}`,
        );
        return reply({ id, status: current.status });
      }
      const now = api.now();
      const cwd = getOrThrow(
        await api.env!.absolutePath(args.cwd ?? ".", context),
      ); // 所有模型工具均有原生 ExecutionEnv。
      const creator = await api.agent(context);
      const when =
        args.when.kind === "cron"
          ? {
              ...args.when,
              expression: args.when.expression.trim(),
              timezone:
                args.when.timezone ??
                Intl.DateTimeFormat().resolvedOptions().timeZone,
            }
          : args.when;
      const permitted = new Set(
        [...creator.tools, ...creator.callable, ...creator.deferred].map(
          ({ name }) => name,
        ),
      );
      const definition = scheduleDefinitionSchema.parse({
        name: args.name,
        cwd,
        when,
        ...("prompt" in args
          ? {
              prompt: args.prompt,
              agent: {
                model: creator.model,
                thinkingLevel: creator.thinkingLevel,
                extensions: creator.extensions
                  .filter(({ name }) => !workerExcludedExtensions.has(name))
                  .map(({ name }) => name),
                tools: api.registry
                  .tools()
                  .map(({ tool }) => tool.name)
                  .filter(
                    (name) =>
                      permitted.has(name) && !workerExcludedTools.has(name),
                  ),
                ...(creator.compaction
                  ? { compaction: creator.compaction }
                  : {}),
              },
            }
          : { command: args.command }),
      });
      const at = firstAt(definition, now);
      const id = newPlanId();
      const status = args.status ?? "enabled";
      const meta: PlanMeta = {
        owner: api.conversationId,
        status,
        createdAt: now,
        activatedAt: now,
        activation: 1,
        registered: false,
      };
      await withPlan(id, context, async () => {
        await createPlan(home, id, meta, definition, context);
      });
      if (status === "enabled") await reconcile(id, context);
      console.info(
        `Schedule created: conversation=${api.conversationId} schedule=${id} runner=${"prompt" in definition ? "agent" : "command"} status=${status}`,
      );
      return reply({
        id,
        status,
        path: schedulePath(home, id),
        metaPath: metaPath(home, id),
        nextAt: status === "enabled" ? at : null,
      });
    },
  });
  return {
    extension: defineExtension({
      name: "amadeus.schedules",
      tasks,
      tools: [schedule, ScheduleResult],
      sections: [
        ScheduleLoopPrompt,
        section("scheduled", async ({ read, conversationId }, context) => {
          if (
            (await read.snapshot(ScheduleWorker, conversationId, context))
              ?.planId
          )
            return;
          return `Use schedule for later or recurring work, with a self-contained script or Agent goal and reporting conditions.
Plans and their ownership live in returned plan.json/meta.json files, not a database directory. plan.json is editable; meta.json is host-managed. Definitions are read before execution and next scheduling. Edits do not interrupt a run or reschedule an existing sleep. Relative cwd resolves from plan.json. Keep the runner type.
Enabled plans run; disabled plans finish the current run and pause; deleted plans cancel current work and cannot be enabled again. One-time plans automatically become deleted after settlement, without suppressing their reports. Deletion retains all files and history. List hides deleted plans unless requested; an explicit ID includes its record. Use enable/disable/delete for lifecycle changes; editing plan.json does not wake paused plans. Do not alter ownership, activation, or registration fields.
Scripts report nonblank stdout; blank stdout is silent and stderr is a log. Workers keep native history and report only when needed. Failures are reported. Plans survive /stop, /new and restarts. Runs are serial and missed periods coalesce; uncertain interrupted scripts are not rerun automatically.`;
        }),
      ],
    }),
    async restore(context: Context) {
      using index = await observeControllers(harness(), context);
      for (const { id } of await scanPlans(home))
        await reconcile(id, context, index);
    },
  };
}
