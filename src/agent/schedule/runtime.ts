import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type {
  ConversationId,
  Cursor,
  Harness,
  TaskId,
  TaskRecord,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import {
  planIdSchema,
  readPlanMeta,
  readScheduleFile,
  scanPlans,
  schedulePath,
  type PlanId,
  type PlanMeta,
} from "./files";
import type { RunResult } from "./tasks";

export const CONTROLLER_KIND = "amadeus.schedule.controller";
const taskIdSchema = z
  .int()
  .positive()
  .transform((value) => {
    // 引用来自 Durable 的持久化任务记录；Zod 校验其数值表示。
    return value as TaskId;
  });
export function ownerId(meta: PlanMeta) {
  // owner 由宿主从原生 Conversation.id 写入，并经 planMetaSchema 校验。
  return meta.owner as ConversationId;
}
export const controllerInputSchema = z.strictObject({
  planId: planIdSchema,
  activation: z.int().positive(),
  owner: z
    .int()
    .positive()
    .transform((value) => {
      // 控制器输入由原生会话 ID 构造。
      return value as ConversationId;
    }),
  firstAt: z.int().nonnegative(),
  before: z.array(taskIdSchema),
  history: taskIdSchema.nullable(),
  runner: z.enum(["command", "agent"]),
});
export type ControllerInput = z.infer<typeof controllerInputSchema>;
export type ControllerResult = {
  reason: "completed" | "disabled" | "deleted" | "superseded";
};
export type ControllerState =
  | { phase: "start" }
  | { phase: "wait"; at: number; worker: ConversationId | null }
  | {
      phase: "collect";
      at: number;
      worker: ConversationId | null;
      run: TaskId<RunResult>;
    };
export type ControllerRecord = TaskRecord<
  ControllerInput,
  JsonValue,
  JsonValue
>;
export type WithPlan = <T>(
  id: PlanId,
  context: Context,
  action: () => Promise<T>,
) => Promise<T>;

export function createPlanLock(): WithPlan {
  const pending = new Map<PlanId, Promise<void>>();
  return async (id, context, action) => {
    const before = pending.get(id);
    const release = Promise.withResolvers<void>();
    pending.set(id, release.promise);
    try {
      await before;
      context.abortSignal?.throwIfAborted();
      return await action();
    } finally {
      release.resolve();
      if (pending.get(id) === release.promise) pending.delete(id);
    }
  };
}
async function* scanControllers(harness: Harness, context: Context) {
  let cursor: Cursor | undefined;
  do {
    const page = await harness.commit(
      (tx) => tx.scanTasks({ kind: CONTROLLER_KIND }, 100, cursor),
      context,
    );
    for (const task of page.items)
      yield { ...task, input: controllerInputSchema.parse(task.input) };
    cursor = page.next;
  } while (cursor);
}
export async function controllerRecords(harness: Harness, context: Context) {
  const records: ControllerRecord[] = [];
  for await (const task of scanControllers(harness, context))
    records.push(task);
  return records;
}
export type ControllerIndex = {
  get(id: PlanId): ControllerRecord[];
  readonly host: ConversationId | undefined;
  [Symbol.dispose](): void;
};
export async function observeControllers(
  harness: Harness,
  context: Context,
): Promise<ControllerIndex> {
  const groups = new Map<PlanId, Map<TaskId, ControllerRecord>>();
  const updated = new Set<TaskId>();
  let latest: ControllerRecord | undefined;
  function put(task: ControllerRecord) {
    let group = groups.get(task.input.planId);
    if (!group) {
      group = new Map();
      groups.set(task.input.planId, group);
    }
    group.set(task.id, task);
    if (!latest || task.id >= latest.id) latest = task;
  }
  const observation = harness.observeCommits({
    advance(publication) {
      for (const change of publication.changes) {
        if (change.type !== "task" || change.value.kind !== CONTROLLER_KIND)
          continue;
        updated.add(change.value.id);
        put({
          ...change.value,
          input: controllerInputSchema.parse(change.value.input),
        });
      }
    },
    end() {},
  });
  try {
    for await (const task of scanControllers(harness, context)) {
      // 扫描页返回后可能已有更晚的提交，不用旧页覆盖它。
      if (!updated.has(task.id)) put(task);
    }
  } catch (error) {
    observation.detach();
    throw error;
  }
  return {
    get(id) {
      return [...(groups.get(id)?.values() ?? [])].sort((a, b) => a.id - b.id);
    },
    get host() {
      return latest?.conversationId;
    },
    [Symbol.dispose]() {
      observation.detach();
    },
  };
}
export async function latestController(
  harness: Harness,
  id: PlanId,
  context: Context,
) {
  let latest: ControllerRecord | undefined;
  for await (const task of scanControllers(harness, context)) {
    if (task.input.planId === id) latest = task;
  }
  return latest;
}
async function latestRuns(
  harness: Harness,
  ids: readonly PlanId[],
  context: Context,
) {
  const requested = new Map(ids.map((id) => [String(id), id]));
  const latest = new Map<PlanId, TaskRecord<JsonValue, JsonValue, JsonValue>>();
  for (const kind of ["amadeus.schedule.run", "amadeus.schedule.agent"]) {
    const remaining = new Set(ids);
    let olderThan: TaskId<JsonValue> | undefined;
    if (latest.size === requested.size) {
      for (const task of latest.values()) {
        if (olderThan === undefined || task.id < olderThan) olderThan = task.id;
      }
    }
    let cursor: Cursor | undefined;
    do {
      const page = await harness.commit(
        (tx) => tx.scanTasks({ kind, order: "descending" }, 100, cursor),
        context,
      );
      for (const task of page.items) {
        const input = task.input;
        if (
          typeof input !== "object" ||
          input === null ||
          Array.isArray(input) ||
          typeof input["planId"] !== "string"
        )
          continue;
        const id = requested.get(input["planId"]);
        if (!id || !remaining.delete(id)) continue;
        const previous = latest.get(id);
        if (!previous || task.id > previous.id) latest.set(id, task);
      }
      if (
        !remaining.size ||
        (olderThan !== undefined &&
          page.items.some((task) => task.id <= olderThan))
      )
        break;
      cursor = page.next;
    } while (cursor);
  }
  return latest;
}
export async function lastRun(harness: Harness, id: PlanId, context: Context) {
  return (await latestRuns(harness, [id], context)).get(id);
}
export async function ownedMeta(
  home: string,
  id: PlanId,
  owner: ConversationId,
) {
  const meta = await readPlanMeta(home, id);
  z.literal(owner).parse(meta.owner);
  return meta;
}
export async function listSchedules(
  home: string,
  harness: Harness,
  owner: ConversationId,
  context: Context,
  options: { id?: PlanId; includeDeleted?: boolean } = {},
) {
  const plans = options.id
    ? [{ id: options.id, meta: await ownedMeta(home, options.id, owner) }]
    : (await scanPlans(home)).filter(
        ({ meta }) =>
          meta.owner === owner &&
          (options.includeDeleted || meta.status !== "deleted"),
      );
  if (!plans.length) return [];
  const ids = plans.map(({ id }) => id);
  const requested = new Set(ids);
  const controllers = new Map<PlanId, ControllerRecord>();
  for await (const task of scanControllers(harness, context)) {
    if (requested.has(task.input.planId))
      controllers.set(task.input.planId, task);
  }
  const runs = await latestRuns(harness, ids, context);
  return await Promise.all(
    plans.map(async ({ id, meta }) => {
      const controller = controllers.get(id);
      const run = runs.get(id);
      const path = schedulePath(home, id);
      const definition = await readScheduleFile(path);
      return { id, meta, definition, path, controller, run };
    }),
  );
}
