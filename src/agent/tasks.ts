import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AgentDoc,
  CompactionTask,
  defineDoc,
  defineExtension,
  defineTask,
  GenerationTask,
  InboxDoc,
  LiveDoc,
  type ConversationId,
  type Cursor,
  type Harness,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";

export const IDLE_COMPACTION_MS = 40 * 60 * 1000;
export const IdleCompactionState = defineDoc<{
  activity: TaskId | null;
  at: number;
  timer: TaskId<null> | null;
}>({
  kind: "amadeus.tasks.idle-compaction",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ activity: null, at: 0, timer: null }),
  checkpointWhen: () => true,
});

type Activity = { activity: TaskId | null; at: number };
function newer(next: Activity, current: Activity) {
  return (
    current.activity === null ||
    next.at > current.at ||
    (next.at === current.at &&
      next.activity !== null &&
      next.activity > current.activity)
  );
}

function createIdleCompactionTask(
  activities: ReadonlyMap<ConversationId, Activity>,
) {
  return defineTask<null, { phase: "wait" }, null>({
    name: "amadeus.tasks.idle-compaction",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: async (task, runtime, context) => {
        await runtime.commit(async (tx) => {
          const id = runtime.conversationId;
          const state = await tx.doc(IdleCompactionState, id);
          if (state.timer === task.id) {
            // 观察事件先同步记录，避免续期提交尚在排队时误判为空闲。
            const latest = activities.get(id);
            if (latest && newer(latest, state)) Object.assign(state, latest);
            const until = state.at + IDLE_COMPACTION_MS;
            if (until > runtime.now())
              return {
                status: "sleeping",
                until,
                checkpoint: { phase: "wait" },
              };
            const live = await tx.doc(LiveDoc, id);
            const inbox = await tx.doc(InboxDoc, id);
            const busy =
              live.run !== undefined ||
              inbox.items.length > 0 ||
              (await hasForegroundWork(tx, id));
            if (!busy && !live.compactions?.length) {
              // 必须由会话拥有：挂在定时任务下会走原生阻塞压缩的直接追加路径。
              const taskId = await tx.createTask(
                CompactionTask,
                { reason: "manual" },
                {
                  ownership: { kind: "conversation" },
                  conversationId: id,
                  background: true,
                },
              );
              (live.compactions ??= []).push({
                taskId,
                trigger: "manual",
                blocking: false,
                attempt: 1,
              });
            }
            state.timer = null;
          }
          return {
            status: "terminal",
            outcome: { status: "completed", result: null },
          };
        }, context);
      },
    },
    abort: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const state = await tx.doc(IdleCompactionState, runtime.conversationId);
        if (state.timer === task.id) state.timer = null;
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context);
    },
  });
}

export function createTasksExtension() {
  const activities = new Map<ConversationId, Activity>();
  const task = createIdleCompactionTask(activities);
  return {
    extension: defineExtension({ name: "amadeus.tasks", tasks: [task] }),
    watch: (harness: Harness) => watchTaskActivity(harness, task, activities),
  };
}

async function hasForegroundWork(tx: Tx, conversationId: ConversationId) {
  for (const status of [
    "pending",
    "running",
    "waiting",
    "sleeping",
    "completing",
  ] as const) {
    const page = await tx.scanTasks(
      { conversationId, background: false, status },
      1,
    );
    if (page.items.length) return true;
  }
  return false;
}

async function watchTaskActivity(
  harness: Harness,
  idleTask: ReturnType<typeof createIdleCompactionTask>,
  activities: Map<ConversationId, Activity>,
) {
  const context = BACKGROUND_CONTEXT;
  await using resources = new AsyncDisposableStack();
  let pending = Promise.resolve();
  async function record(
    conversationId: ConversationId,
    activity: TaskId,
    at: number,
  ) {
    await harness.commit(async (tx) => {
      if (
        (await tx.conversation(conversationId))?.owner ||
        !(await tx.doc(AgentDoc, conversationId)).model
      )
        return;
      const state = await tx.doc(IdleCompactionState, conversationId);
      if (!newer({ activity, at }, state)) return;
      const timer =
        state.timer === null ? undefined : await tx.task(state.timer);
      state.activity = activity;
      state.at = at;
      if (timer && !timer.abortRequested && timer.state.status !== "terminal")
        return;
      state.timer = await tx.createTask(idleTask, null, {
        ownership: { kind: "conversation" },
        conversationId,
        background: true,
      });
    }, context);
  }
  const observation = harness.observeCommits({
    advance(publication) {
      for (const change of publication.changes) {
        if (change.type !== "task") continue;
        const task = change.value;
        if (
          task.background ||
          task.kind === CompactionTask.definition.name ||
          task.state.status !== "terminal" ||
          task.endedAt === undefined
        )
          continue;
        const at = task.endedAt;
        const latest = { activity: task.id, at };
        const previous = activities.get(task.conversationId);
        if (!previous || newer(latest, previous))
          activities.set(task.conversationId, latest);
        pending = pending
          .then(async () => {
            await record(task.conversationId, task.id, at);
            if (activities.get(task.conversationId) === latest)
              activities.delete(task.conversationId);
          })
          .catch((error: unknown) => console.error(error));
      }
    },
    end() {},
  });
  resources.defer(async () => {
    observation.detach();
    await pending;
    activities.clear();
  });

  // 补齐结束事件与活动记录之间崩溃的窗口；已保存的期限不会因重启而推迟。
  let cursor: Cursor | undefined;
  do {
    const page = await harness.commit(
      (tx) => tx.scanConversations({}, 64, cursor),
      context,
    );
    for (const conversation of page.items) {
      if (conversation.owner) continue;
      const latest = await harness.commit(
        (tx) =>
          tx.scanTasks(
            {
              conversationId: conversation.id,
              kind: GenerationTask.definition.name,
              order: "descending",
            },
            1,
          ),
        context,
      );
      const task = latest.items[0];
      if (task?.state.status === "terminal" && task.endedAt !== undefined)
        await record(conversation.id, task.id, task.endedAt);
    }
    cursor = page.next;
  } while (cursor !== undefined);
  const cleanup = resources.move();
  return { close: () => cleanup.disposeAsync() };
}
