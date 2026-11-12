import type { Context } from "@earendil-works/chord/context";
import {
  defineTask,
  type Harness,
  type NextTaskState,
  type TaskId,
  type TaskRuntime,
} from "@earendil-works/pi-durable";
import { constants, writeFileSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { NotificationTask } from "../../channels/notifications";
import {
  agentScheduleSchema,
  ensureDirectory,
  nextCron,
  planDirectory,
  readPlanMeta,
  readScheduleFile,
  schedulePath,
  scriptScheduleSchema,
  writePlanMeta,
  type PlanId,
  type PlanMeta,
  type ScheduleDefinition,
} from "./files";
import {
  configureWorker,
  createRunAgent,
  ScheduleWorker,
  type AgentRunResult,
} from "./loop";
import {
  CONTROLLER_KIND,
  type ControllerInput,
  type ControllerResult,
  type ControllerSettlement,
  type ControllerState,
  type WithPlan,
} from "./runtime";

export type CommandRunResult = {
  kind: "command";
  status: "completed" | "failed" | "interrupted";
  exitCode: number | null;
  stdoutPath: string;
  stderrPath: string;
  error: string | null;
};
export type RunResult = CommandRunResult | AgentRunResult;
type Runtime = TaskRuntime<
  ControllerInput,
  ControllerState,
  ControllerResult,
  object
>;
type ControlIdentity = { id: TaskId; input: ControllerInput };
export function runPaths(home: string, id: PlanId, run: TaskId) {
  const root = join(planDirectory(home, id), "runs", String(run));
  return {
    root,
    stdoutPath: join(root, "stdout.log"),
    stderrPath: join(root, "stderr.log"),
  };
}
function ended(
  reason: ControllerResult["reason"],
): NextTaskState<ControllerState, ControllerResult> {
  return {
    status: "terminal",
    outcome: { status: "completed", result: { reason } },
  };
}
function inactive(meta: PlanMeta, input: ControllerInput) {
  return meta.status !== "enabled"
    ? meta.status
    : meta.activation !== input.activation
      ? "superseded"
      : undefined;
}

export function createScheduleTasks(
  home: string,
  harness: () => Harness,
  withPlan: WithPlan,
) {
  const RunAgent = createRunAgent(home, harness, withPlan);
  const RunCommand = defineTask<
    { planId: PlanId; owner: ControllerInput["owner"] },
    { phase: "start" } | { phase: "interrupted" },
    CommandRunResult
  >({
    name: "amadeus.schedule.run",
    version: 1,
    initial: () => ({ phase: "start" }),
    phases: {
      start: async (task, runtime, context) => {
        const prepared = await withPlan(
          task.input.planId,
          context,
          async () => {
            const meta = await readPlanMeta(home, task.input.planId);
            z.literal(task.input.owner).parse(meta.owner);
            if (meta.status === "deleted") {
              await runtime.commit(
                () => ({ status: "terminal", outcome: { status: "aborted" } }),
                context,
              );
              return;
            }
            const definition = scriptScheduleSchema.parse(
              await readScheduleFile(schedulePath(home, task.input.planId)),
            );
            const files = runPaths(home, task.input.planId, task.id);
            await ensureDirectory(
              join(planDirectory(home, task.input.planId), "runs"),
            );
            await ensureDirectory(files.root);
            const flags =
              constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_APPEND |
              constants.O_NOFOLLOW;
            const stdout = await open(files.stdoutPath, flags, 0o600);
            try {
              const stderr = await open(files.stderrPath, flags, 0o600);
              try {
                z.literal(true).parse((await stdout.stat()).isFile());
                z.literal(true).parse((await stderr.stat()).isFile());
                await runtime.commit(
                  () => ({
                    status: "running",
                    checkpoint: { phase: "interrupted" },
                  }),
                  context,
                );
                return { definition, files, stdout, stderr };
              } catch (error) {
                await stderr.close();
                throw error;
              }
            } catch (error) {
              await stdout.close();
              throw error;
            }
          },
        );
        if (!prepared) return;
        const { definition, files, stdout, stderr } = prepared;
        let result: CommandRunResult;
        {
          await using outputs = new AsyncDisposableStack();
          outputs.use(stdout);
          outputs.use(stderr);
          const env = await runtime.env(context);
          runtime.signal.throwIfAborted();
          console.info(
            `Running scheduled command: schedule=${task.input.planId} run=${task.id}`,
          );
          // openAgent 为所有任务提供原生 ExecutionEnv。
          const executed = await env!.exec(
            definition.command,
            {
              cwd: definition.cwd,
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
            kind: "command",
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
        const files = runPaths(home, task.input.planId, task.id);
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: {
              status: "completed",
              result: {
                kind: "command",
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
    abort: async (_task, runtime, context) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      ),
  });
  async function fail(
    task: ControlIdentity,
    runtime: Runtime,
    error: unknown,
    context: Context,
  ) {
    runtime.report(error);
    const message = Bun.inspect(error);
    await runtime.commit(async (tx) => {
      await tx.createTask(
        NotificationTask,
        {
          eventKey: `schedule:${task.id}:configuration`,
          message,
          sourceTask: task.id,
          metadata: {
            source: "schedule",
            scheduleId: task.input.planId,
            runner: task.input.runner,
          },
          data: null,
        },
        {
          ownership: { kind: "conversation" },
          conversationId: task.input.owner,
          background: true,
        },
      );
      return {
        status: "terminal",
        outcome: { status: "failed", error: { message } },
      };
    }, context);
  }
  async function metadata(
    task: ControlIdentity,
    runtime: Runtime,
    context: Context,
  ) {
    try {
      const meta = await readPlanMeta(home, task.input.planId);
      z.literal(task.input.owner).parse(meta.owner);
      return meta;
    } catch (error) {
      await fail(task, runtime, error, context);
      return;
    }
  }
  async function definition(
    task: ControlIdentity,
    runtime: Runtime,
    context: Context,
  ) {
    try {
      const value = await readScheduleFile(
        schedulePath(home, task.input.planId),
      );
      return task.input.runner === "command"
        ? scriptScheduleSchema.parse(value)
        : agentScheduleSchema.parse(value);
    } catch (error) {
      await fail(task, runtime, error, context);
      return;
    }
  }
  const Controller = defineTask<
    ControllerInput,
    ControllerState,
    ControllerResult
  >({
    name: CONTROLLER_KIND,
    version: 1,
    initial: () => ({ phase: "start" }),
    phases: {
      start: async (task, runtime, context) =>
        withPlan(task.input.planId, context, async () => {
          const meta = await metadata(task, runtime, context);
          if (!meta) return;
          const reason = inactive(meta, task.input);
          if (reason) return runtime.commit(() => ended(reason), context);
          const plan = await definition(task, runtime, context);
          if (!plan) return;
          if (!meta.registered)
            await writePlanMeta(
              home,
              task.input.planId,
              { ...meta, registered: true },
              context,
            );
          await runtime.commit(async (tx) => {
            let previousWorker;
            let at;
            const before = [];
            for (const id of task.input.before) {
              const previous = await tx.task(id);
              if (previous && previous.state.status !== "terminal")
                before.push(previous.id);
            }
            if (before.length)
              return {
                status: "waiting",
                on: before,
                policy: "allSettled",
                checkpoint: { phase: "start" },
              };
            if (task.input.history !== null) {
              previousWorker = (
                await tx.scanConversations(
                  { ownerTaskId: task.input.history },
                  1,
                )
              ).items[0];
              if (previousWorker)
                at = await tx.latestEntryId(previousWorker.id);
            }
            let worker = null;
            if ("prompt" in plan) {
              const created =
                previousWorker && at !== undefined
                  ? await tx.forkConversation(previousWorker.id, at, {
                      ownership: { kind: "task", taskId: task.id },
                    })
                  : await tx.createConversation({
                      ownership: { kind: "task", taskId: task.id },
                    });
              worker = created.id;
              await configureWorker(tx, worker, plan, runtime.registry);
              (await tx.doc(ScheduleWorker, worker)).planId = task.input.planId;
            }
            return {
              status: "running",
              checkpoint: { phase: "wait", at: task.input.firstAt, worker },
            };
          }, context);
        }),
      wait: async (task, runtime, context) =>
        withPlan(task.input.planId, context, async () => {
          const meta = await metadata(task, runtime, context);
          if (!meta) return;
          const reason = inactive(meta, task.input);
          if (reason) return runtime.commit(() => ended(reason), context);
          const { at, worker } = task.state.checkpoint;
          if (runtime.now() < at)
            return runtime.sleepUntil(
              at,
              { phase: "wait", at, worker },
              context,
            );
          await runtime.commit(async (tx) => {
            const run =
              worker !== null
                ? await tx.createTask(
                    RunAgent,
                    {
                      planId: task.input.planId,
                      owner: task.input.owner,
                      worker,
                    },
                    { ownership: { kind: "task", taskId: task.id } },
                  )
                : await tx.createTask(
                    RunCommand,
                    { planId: task.input.planId, owner: task.input.owner },
                    { ownership: { kind: "task", taskId: task.id } },
                  );
            return {
              status: "waiting",
              on: [run],
              policy: "allSettled",
              checkpoint: { phase: "collect", at, worker, run },
            };
          }, context);
        }),
      collect: async (task, runtime, context) => {
        const { run, at, worker } = task.state.checkpoint;
        // 原生 allSettled 的唯一子任务已有终态收据。
        const outcome = (await runtime.outcomes([run], context))[0]!;
        if (outcome.status === "aborted")
          return runtime.commit(
            () => ({ status: "terminal", outcome: { status: "aborted" } }),
            context,
          );
        const result =
          outcome.status === "completed" ? outcome.result : undefined;
        let message = "";
        if (result?.kind === "agent") {
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
        } else if (result?.status === "interrupted")
          message = JSON.stringify({
            status: "interrupted",
            scheduleId: task.input.planId,
            runId: run,
          });
        else if (outcome.status === "failed" || outcome.status === "faulted")
          message = outcome.error.message;
        else if (outcome.status !== "completed")
          message = JSON.stringify(outcome);
        await withPlan(task.input.planId, context, async () => {
          const meta = await metadata(task, runtime, context);
          if (!meta) return;
          if (meta.status === "deleted")
            return runtime.commit(() => ended("deleted"), context);
          let plan: ScheduleDefinition | undefined;
          if (result) {
            try {
              plan = await readScheduleFile(
                schedulePath(home, task.input.planId),
              );
            } catch (error) {
              runtime.report(error);
              message = [message, Bun.inspect(error)]
                .filter(Boolean)
                .join("\n");
            }
          }
          console.info(
            `Scheduled run ended: schedule=${task.input.planId} run=${run} outcome=${outcome.status} result=${result?.status ?? "unknown"}`,
          );
          await runtime.commit(async (tx) => {
            if (message)
              await tx.createTask(
                NotificationTask,
                {
                  eventKey: `schedule:${task.id}:${run}`,
                  message,
                  sourceTask: task.id,
                  metadata: {
                    source: "schedule",
                    scheduleId: task.input.planId,
                    ...(plan ? { name: plan.name } : {}),
                    runId: run,
                    runner: task.input.runner,
                  },
                  data: { kind: "schedule", outcome },
                },
                {
                  ownership: { kind: "conversation" },
                  conversationId: task.input.owner,
                  background: true,
                },
              );
            if (plan?.when.kind === "after" || plan?.when.kind === "at") {
              const settlement: ControllerSettlement =
                result?.status === "completed"
                  ? { status: "completed", result: { reason: "completed" } }
                  : {
                      status: "failed",
                      error: { message: message || "interrupted" },
                      result: { reason: "completed" },
                    };
              // 通知与收尾意图同事务；重启后只补文件状态，不再次执行或创建通知。
              return {
                status: "running",
                checkpoint: { phase: "finish", outcome: settlement },
              };
            }
            if (!result || result.status === "interrupted" || !plan)
              return {
                status: "terminal",
                outcome: {
                  status: "failed",
                  error: { message: message || "interrupted" },
                },
              };
            const reason = inactive(meta, task.input);
            if (reason) return ended(reason);
            const next =
              plan.when.kind === "cron"
                ? nextCron(plan.when, Math.max(at, runtime.now()))
                : z
                    .int()
                    .nonnegative()
                    .parse(
                      at +
                        (Math.floor(
                          Math.max(0, runtime.now() - at) /
                            plan.when.intervalMs,
                        ) +
                          1) *
                          plan.when.intervalMs,
                    );
            return {
              status: "sleeping",
              until: next,
              checkpoint: { phase: "wait", at: next, worker },
            };
          }, context);
        });
      },
      finish: async (task, runtime, context) =>
        withPlan(task.input.planId, context, async () => {
          const meta = await metadata(task, runtime, context);
          if (!meta) return;
          // 旧运行不得覆盖用户已重新启用的新激活。
          if (
            meta.activation === task.input.activation &&
            meta.status !== "deleted"
          )
            await writePlanMeta(
              home,
              task.input.planId,
              { ...meta, status: "deleted" },
              context,
            );
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: task.state.checkpoint.outcome,
            }),
            context,
          );
        }),
    },
    abort: async (_task, runtime, context) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      ),
  });
  return { Controller, tasks: [Controller, RunCommand, RunAgent] };
}
