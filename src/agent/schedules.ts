import {
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  section,
  type ConversationId,
  type Harness,
  type TaskId,
} from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import {
  arr,
  bool,
  int,
  lit,
  obj,
  nullable,
  opt,
  str,
  union,
  unknown,
} from "@earendil-works/pi-schema";
import { CronExpressionParser } from "cron-parser";
import { constants, writeFileSync } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { NotificationTask } from "../channels/notifications";
import {
  RunAgent,
  ScheduleWorker,
  ScheduleResult,
  ScheduleLoopPrompt,
  type AgentRunResult,
} from "./schedule-loop";

type CommandRunResult = {
  status: "completed" | "failed" | "interrupted";
  exitCode: number | null;
  stdoutPath: string;
  stderrPath: string;
  error: string | null;
};
type RunResult = CommandRunResult | AgentRunResult;
type Cron = { expression: string; timezone: string };
type Job = {
  name: string;
  cwd: string;
  lastRun: TaskId<RunResult> | null;
} & (
  { intervalMs: number | null; cron?: never } | { intervalMs: null; cron: Cron }
) &
  (
    | { command: string; prompt?: never; worker?: never }
    | { command?: never; prompt: string; worker: ConversationId }
  );

function nextCron(cron: Cron, after: number) {
  return CronExpressionParser.parse(cron.expression, {
    currentDate: after,
    tz: cron.timezone,
    // H 字段在重复解析及重启后保持同一组取值。
    hashSeed: cron.expression,
  })
    .next()
    .getTime();
}
export const Schedules = defineDoc<{ jobs: Record<string, Job> }>({
  kind: "amadeus.schedules",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ jobs: {} }),
  checkpointWhen: () => true,
});
const ScheduleHost = defineDoc<{ conversation: ConversationId | null }>({
  kind: "amadeus.schedules.host",
  version: 1,
  scope: "session",
  initial: () => ({ conversation: null }),
  checkpointWhen: () => true,
});

async function directory(path: string) {
  await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
  });
  z.literal(true).parse((await lstat(path)).isDirectory());
}
function reply(value: unknown) {
  const data = z.json().parse(value);
  return {
    output: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredOutput: data,
  };
}

export function createSchedulesExtension(
  stateDirectory: string,
  abortTask: Harness["abortTask"],
) {
  const logRoot = join(stateDirectory, "schedules");
  const paths = (schedule: TaskId, run: TaskId) => {
    const root = join(logRoot, String(schedule), String(run));
    return {
      root,
      stdoutPath: join(root, "stdout.log"),
      stderrPath: join(root, "stderr.log"),
    };
  };
  const RunCommand = defineTask<
    { schedule: TaskId; command: string; cwd: string },
    { phase: "start" } | { phase: "interrupted" },
    CommandRunResult
  >({
    name: "amadeus.schedule.run",
    version: 1,
    initial: () => ({ phase: "start" }),
    phases: {
      start: async (task, runtime, context) => {
        const files = paths(task.input.schedule, task.id);
        await directory(logRoot);
        await directory(join(logRoot, String(task.input.schedule)));
        await directory(files.root);
        const env = await runtime.env(context);
        let result: CommandRunResult;
        {
          // 只追加应用自己的运行日志；恢复执行栅栏后不会再次启动命令。
          const flags =
            constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_APPEND |
            constants.O_NOFOLLOW;
          await using stdout = await open(files.stdoutPath, flags, 0o600);
          await using stderr = await open(files.stderrPath, flags, 0o600);
          z.literal(true).parse((await stdout.stat()).isFile());
          z.literal(true).parse((await stderr.stat()).isFile());
          await runtime.commit(
            () => ({ status: "running", checkpoint: { phase: "interrupted" } }),
            context,
          );
          console.info(
            `Running scheduled command: schedule=${task.input.schedule} run=${task.id}`,
          );
          // openAgent 始终提供原生 ExecutionEnv，命令取消沿用当前任务 Context。
          const executed = await env!.exec(
            task.input.command,
            {
              cwd: task.input.cwd,
              onOutput(text, _context, info) {
                writeFileSync(
                  info.stream === "stdout" ? stdout.fd : stderr.fd,
                  text,
                );
              },
            },
            context,
          );
          runtime.signal.throwIfAborted();
          if (!executed.ok) runtime.report(executed.error);
          result = {
            status:
              executed.ok && executed.value.exitCode === 0
                ? "completed"
                : "failed",
            exitCode: executed.ok ? executed.value.exitCode : null,
            stdoutPath: files.stdoutPath,
            stderrPath: files.stderrPath,
            error: executed.ok ? null : Bun.inspect(executed.error),
          };
        }
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result },
          }),
          context,
        );
      },
      interrupted: async (task, runtime, context) => {
        const files = paths(task.input.schedule, task.id);
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: {
              status: "completed",
              result: {
                status: "interrupted",
                exitCode: null,
                stdoutPath: files.stdoutPath,
                stderrPath: files.stderrPath,
                error: null,
              },
            },
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
  type ScheduleState =
    | { phase: "wait"; at: number }
    | { phase: "collect"; at: number; run: TaskId<RunResult> };
  const ScheduledCommand = defineTask<
    { owner: ConversationId; firstAt: number },
    ScheduleState,
    null
  >({
    name: "amadeus.schedule",
    version: 1,
    initial: (input) => ({ phase: "wait", at: input.firstAt }),
    phases: {
      wait: async (task, runtime, context) => {
        const { at } = task.state.checkpoint;
        if (runtime.now() < at)
          return runtime.sleepUntil(at, { phase: "wait", at }, context);
        await runtime.commit(async (tx) => {
          // 创建和删除流程保证运行中的计划仍在所属会话目录内。
          const job = (await tx.doc(Schedules, task.input.owner)).jobs[
            task.id
          ]!;
          const run =
            job.worker !== undefined
              ? await tx.createTask(
                  RunAgent,
                  { worker: job.worker, prompt: job.prompt },
                  { ownership: { kind: "task", taskId: task.id } },
                )
              : await tx.createTask(
                  RunCommand,
                  { schedule: task.id, command: job.command, cwd: job.cwd },
                  { ownership: { kind: "task", taskId: task.id } },
                );
          job.lastRun = run;
          return {
            status: "waiting",
            on: [run],
            policy: "allSettled",
            checkpoint: { phase: "collect", at, run },
          };
        }, context);
      },
      collect: async (task, runtime, context) => {
        const { run, at } = task.state.checkpoint;
        // 原生 allSettled 等待的唯一任务已有终态收据。
        const outcome = (await runtime.outcomes([run], context))[0]!;
        if (outcome.status === "aborted")
          return runtime.commit(
            () => ({ status: "terminal", outcome: { status: "aborted" } }),
            context,
          );
        const result =
          outcome.status === "completed" ? outcome.result : undefined;
        let message = "";
        if (result && "kind" in result) {
          if (result.status === "failed")
            message = JSON.stringify(result.failure);
          else if (result.decision.notify) message = result.decision.message;
        } else if (result?.status === "completed") {
          const stdout = await readFile(result.stdoutPath, "utf8");
          if (stdout.trim()) message = stdout;
        } else if (result?.status === "failed") {
          message = result.error ?? (await readFile(result.stderrPath, "utf8"));
          if (!message.trim())
            message = await readFile(result.stdoutPath, "utf8");
          if (!message.trim())
            message = JSON.stringify({ exitCode: result.exitCode });
        } else if (result?.status === "interrupted") {
          message = JSON.stringify({
            status: "interrupted",
            scheduleId: task.id,
            runId: run,
          });
        } else if (
          outcome.status === "failed" ||
          outcome.status === "faulted"
        ) {
          message = outcome.error.message;
        } else if (outcome.status !== "completed") {
          message = JSON.stringify(outcome);
        }
        console.info(
          `Scheduled run ended: schedule=${task.id} run=${run} outcome=${outcome.status} result=${result?.status ?? "unknown"}`,
        );
        const uncertain = !result || result.status === "interrupted";
        await runtime.commit(async (tx) => {
          // 目录和控制器同事务创建，只有终态计划才能删除。
          const job = (await tx.doc(Schedules, task.input.owner)).jobs[
            task.id
          ]!;
          if (message)
            await tx.createTask(
              NotificationTask,
              {
                eventKey: `schedule:${task.id}:${run}`,
                message,
                sourceTask: task.id,
                metadata: {
                  source: "schedule",
                  scheduleId: task.id,
                  name: job.name,
                  runId: run,
                  runner: job.worker === undefined ? "command" : "agent",
                },
                data: { kind: "schedule", outcome },
              },
              {
                ownership: { kind: "conversation" },
                conversationId: task.input.owner,
                background: true,
              },
            );
          let next: number | undefined;
          if (!uncertain) {
            if (job.cron)
              next = nextCron(job.cron, Math.max(at, runtime.now()));
            else if (job.intervalMs !== null)
              next = z
                .int()
                .nonnegative()
                .parse(
                  at +
                    (Math.floor(
                      Math.max(0, runtime.now() - at) / job.intervalMs,
                    ) +
                      1) *
                      job.intervalMs,
                );
          }
          if (next !== undefined) {
            return {
              status: "sleeping",
              until: next,
              checkpoint: { phase: "wait", at: next },
            };
          }
          return uncertain || result.status === "failed"
            ? {
                status: "terminal",
                outcome: {
                  status: "failed",
                  error: { message: message || "interrupted" },
                },
              }
            : {
                status: "terminal",
                outcome: { status: "completed", result: null },
              };
        }, context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      );
    },
  });

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
          "Milliseconds between runs; first run after this interval. 1800000 = 30 minutes.",
      }),
    }),
    obj({
      kind: lit("cron"),
      expression: str({
        minLength: 1,
        pattern: "\\S",
        description:
          "Five fields, or six with leading seconds. Example: '0 9 * * 1-5'.",
      }),
      timezone: opt(
        str({
          minLength: 1,
          description:
            "IANA timezone, e.g. Asia/Shanghai. Defaults to the host timezone at creation.",
        }),
      ),
    }),
  ]);
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
  };
  const schedule = defineTool({
    name: "schedule",
    description:
      "Manage this conversation's scheduled work: create a script or Agent task, list plans/results, or delete to stop and remove a plan. After an interrupted call, list before retrying changes.",
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
              "Self-contained Agent task and reporting conditions; the worker retains earlier runs.",
          }),
        }),
        obj({
          action: lit("list"),
          id: opt(
            int({
              minimum: 1,
              description: "Omit for all plans; set for details and log paths.",
            }),
          ),
        }),
        obj({
          action: lit("delete"),
          id: int({
            minimum: 1,
            description:
              "Stops running work and removes the plan; keeps receipts and logs.",
          }),
        }),
      ]),
    },
    structuredOutputSchema: union([
      obj({ id: int(), name: str(), nextAt: int() }),
      obj({
        schedules: arr(
          obj({
            id: int(),
            name: str(),
            command: nullable(str()),
            prompt: nullable(str()),
            worker: nullable(int()),
            cwd: str(),
            intervalMs: nullable(int()),
            cron: nullable(obj({ expression: str(), timezone: str() })),
            state: unknown(),
            lastRun: unknown(),
            runId: nullable(int()),
            logs: nullable(obj({ stdoutPath: str(), stderrPath: str() })),
          }),
        ),
      }),
      obj({ id: int(), deleted: bool() }),
    ]),
    replay: "unsafe",
    async execute(args, api, context) {
      if (args.action === "list") {
        const catalog = await api.snapshot(
          Schedules,
          api.conversationId,
          context,
        );
        const ids =
          args.id === undefined
            ? Object.keys(catalog?.jobs ?? {}).map(Number)
            : [args.id];
        const schedules: unknown[] = [];
        for (const id of ids) {
          const { id: taskId, job } = owned(catalog, id);
          // 目录与原生任务原子创建；只有目录项会被逻辑删除。
          const task = (await api.getTask(taskId, context))!;
          const last = job.lastRun
            ? await api.getTask(job.lastRun, context)
            : null;
          schedules.push({
            id,
            name: job.name,
            command: job.command ?? null,
            prompt: job.prompt ?? null,
            worker: job.worker ?? null,
            cwd: job.cwd,
            intervalMs: job.intervalMs,
            cron: job.cron ?? null,
            state: task.state,
            lastRun: last?.state ?? null,
            runId: job.lastRun,
            logs:
              job.worker === undefined && job.lastRun
                ? {
                    stdoutPath: paths(taskId, job.lastRun).stdoutPath,
                    stderrPath: paths(taskId, job.lastRun).stderrPath,
                  }
                : null,
          });
        }
        return reply({ schedules });
      }
      if (args.action === "delete") {
        const { id } = owned(
          await api.snapshot(Schedules, api.conversationId, context),
          args.id,
        );
        await abortTask(id, context);
        await api.waitForTask(id, context);
        await api.commit(async (tx) => {
          delete (await tx.doc(Schedules, api.conversationId)).jobs[id];
        }, context);
        console.info(
          `Schedule deleted: conversation=${api.conversationId} schedule=${id}`,
        );
        return reply({ id, deleted: true });
      }
      const now = api.now();
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
      const firstAt = z
        .int()
        .nonnegative()
        .parse(
          when.kind === "cron"
            ? nextCron(when, now)
            : when.kind === "at"
              ? Date.parse(z.iso.datetime({ offset: true }).parse(when.at))
              : now + (when.kind === "after" ? when.delayMs : when.intervalMs),
        );
      // 应用的所有模型工具都有原生 ExecutionEnv。
      const cwd = getOrThrow(
        await api.env!.absolutePath(args.cwd ?? ".", context),
      );
      const creator = await api.agent(context);
      const permitted = new Set(
        [...creator.tools, ...creator.callable, ...creator.deferred].map(
          ({ name }) => name,
        ),
      );
      const workerTools = api.registry
        .tools()
        .map(({ tool }) => tool)
        .filter(
          ({ name }) =>
            permitted.has(name) &&
            name !== "schedule" &&
            name !== "send_file" &&
            name !== ScheduleResult.name,
        );
      const id = await api.commit(async (tx) => {
        const catalog = await tx.doc(Schedules, api.conversationId);
        const host = await tx.doc(ScheduleHost);
        host.conversation ??= (
          await tx.createConversation({ ownership: { kind: "ownerless" } })
        ).id;
        const id = await tx.createTask(
          ScheduledCommand,
          { owner: api.conversationId, firstAt },
          {
            ownership: { kind: "conversation" },
            conversationId: host.conversation,
            background: true,
          },
        );
        let execution:
          { prompt: string; worker: ConversationId } | { command: string };
        if ("prompt" in args) {
          const worker = await tx.createConversation({
            ownership: { kind: "task", taskId: id },
          });
          await configure(tx, worker.id, {
            ...(creator.model ? { model: creator.model } : {}),
            thinkingLevel: creator.thinkingLevel,
            cwd,
            instructions: null,
            ...(creator.compaction ? { compaction: creator.compaction } : {}),
            extensions: creator.extensions.filter(
              ({ name }) =>
                ![
                  "amadeus.telegram",
                  "amadeus.ipc",
                  "amadeus.notifications",
                ].includes(name),
            ),
            tools: [...workerTools, ScheduleResult],
            modelTools: { add: [ScheduleResult] },
          });
          (await tx.doc(ScheduleWorker, worker.id)).schedule = id;
          execution = { prompt: args.prompt, worker: worker.id };
        } else execution = { command: args.command };
        catalog.jobs[id] = {
          name: args.name,
          ...execution,
          cwd,
          ...(when.kind === "cron"
            ? {
                cron: { expression: when.expression, timezone: when.timezone },
                intervalMs: null,
              }
            : { intervalMs: when.kind === "every" ? when.intervalMs : null }),
          lastRun: null,
        };
        return id;
      }, context);
      console.info(
        `Schedule created: conversation=${api.conversationId} schedule=${id} runner=${"prompt" in args ? "agent" : "command"} next=${firstAt}`,
      );
      return reply({ id, name: args.name, nextAt: firstAt });
    },
  });
  function owned(
    catalog: Readonly<{ jobs: Record<string, Job> }> | undefined,
    id: number,
  ) {
    const job = catalog?.jobs[id];
    if (job === undefined) return z.never().parse(id);
    // ID 来自当前会话的已验证目录；底层任务不会删除或复用。
    return { id: id as TaskId<null>, job };
  }
  return defineExtension({
    name: "amadeus.schedules",
    tasks: [ScheduledCommand, RunCommand, RunAgent],
    tools: [schedule, ScheduleResult],
    sections: [
      ScheduleLoopPrompt,
      section("scheduled", async ({ read, conversationId }, context) => {
        if (
          (await read.snapshot(ScheduleWorker, conversationId, context))
            ?.schedule
        )
          return;
        return `Use schedule for later or recurring work, with a self-contained command or Agent goal and reporting conditions.
For scripts, stdout is a report; blank stdout is silent and stderr is a log. Workers keep their history and report only when needed. Failures are reported.
Use list to inspect and delete to stop/remove; receipts and logs remain. Remove handled one-shots; keep recurring plans until asked otherwise.
Plans survive /stop, /new and restarts. Runs are serial; missed runs coalesce. Interrupted scripts with unknown results are not rerun automatically; check effects before replacing them.`;
      }),
    ],
  });
}
