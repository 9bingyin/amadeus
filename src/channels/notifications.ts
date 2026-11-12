import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import {
  defineEntry,
  defineExtension,
  defineTask,
  type ConversationId,
  type JsonObject,
  type SubmissionId,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { IpcPrompt } from "./ipc/prompt";

export type Notification = {
  eventKey: string;
  message: string;
  data: JsonValue;
  sourceTask: TaskId;
  /** 宿主生产方注入的来源元数据，不接受 IPC 客户端覆盖。 */
  metadata?: JsonObject;
};
const weekday = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  timeZone: "UTC",
});

export function formatNotification(
  notification: Notification,
  at: number,
): string {
  const date = new Date(at);
  const timestamp = `${weekday.format(date)} ${date.toISOString().replace("T", " ").replace(".000Z", "Z")}`;
  const source = notification.metadata?.["source"];
  const label =
    source === "ipc"
      ? "IPC"
      : source === "schedule"
        ? "Schedule"
        : "Notification";
  const lines = [`[${label} ${timestamp}]`];
  if (notification.metadata)
    lines.push(
      `[Metadata: ${JSON.stringify(notification.metadata).replaceAll("<", "\\u003c")}]`,
    );
  if (notification.data !== null)
    lines.push(
      `[Data: ${JSON.stringify(notification.data).replaceAll("<", "\\u003c")}]`,
    );
  lines.push(notification.message);
  return lines.join("\n");
}
export const NotificationEntry = defineEntry<Notification>(
  "amadeus.ipc.notification",
);
type NotificationHooks = {
  /** 此钩子在提交内运行，只通过 tx 访问状态。 */
  admitted(
    tx: Tx,
    conversation: ConversationId,
    submission: SubmissionId,
    context: Context,
  ): Promise<void>;
};
export const NotificationTask = defineTask<
  Notification,
  { phase: "submit" },
  null,
  NotificationHooks
>({
  name: "amadeus.ipc.notify",
  version: 1,
  initial: () => ({ phase: "submit" }),
  phases: {
    submit: async (task, runtime, context) => {
      // 任务由已有会话拥有，应用没有删除原生会话的路径。
      const conversation = (await runtime.conversation(
        runtime.conversationId,
        context,
      ))!;
      // hooks 会读取当前 Agent；先在提交线外解析，避免冷启动时嵌套读取死锁。
      await runtime.agent(context);
      await runtime.commit(async (tx) => {
        const submission = await conversation.submit(tx, {
          type: "input",
          content: [
            {
              type: "text",
              text: formatNotification(
                task.input,
                task.startedAt ?? runtime.now(),
              ),
            },
          ],
          entry: { kind: NotificationEntry.kind, data: task.input },
          requestId: `ipc:${task.id}`,
          whenBusy: "followUp",
        });
        await runtime.hooks.each("admitted", (hook) =>
          hook(tx, runtime.conversationId, submission, context),
        );
        return {
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

export const NotificationsExtension = defineExtension({
  name: "amadeus.notifications",
  tasks: [NotificationTask],
  sections: [IpcPrompt],
});
