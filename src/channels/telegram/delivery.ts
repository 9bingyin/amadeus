import { contentText } from "@earendil-works/pi-ai/utils/text";
import {
  AssistantEntry,
  defineTask,
  type ConversationId,
  type EntryId,
  type Harness,
  type SubmissionId,
  type Task,
} from "@earendil-works/pi-durable";

import { Ingress, type Destination, type InputSource } from "./inbound";
import { formatReply, type FormattedMessage } from "./format";

type DeliveryInput = InputSource &
  (
    | { kind: "answer"; id: EntryId }
    | { kind: "failure"; id: SubmissionId }
    | { kind: "error"; text: string }
  );
type DeliveryState =
  | { phase: "prepare" }
  | { phase: "send"; chunks: (string | FormattedMessage)[]; next: number };
export type DeliveryTask = Task<DeliveryInput, DeliveryState, null, object>;
type SendText = (
  conversation: ConversationId,
  destination: Destination,
  message: FormattedMessage,
  signal: AbortSignal,
) => Promise<void>;

function splitText(text: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const character of text) {
    if (chunk.length + character.length > 4096) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export function createDeliveryTask(
  harness: Harness,
  send: SendText,
): DeliveryTask {
  return defineTask<DeliveryInput, DeliveryState, null>({
    name: "amadeus.telegram.deliver",
    version: 1,
    initial: () => ({ phase: "prepare" }),
    phases: {
      prepare: async (task, runtime, context) => {
        let text = "";
        if (task.input.kind === "error") {
          text = task.input.text;
        } else if (task.input.kind === "answer") {
          const answer = await runtime.entry(
            AssistantEntry,
            task.input.id,
            context,
          );
          text = (answer?.model ?? [])
            .filter((message) => message.role === "assistant")
            .map((message) => contentText(message.content))
            .join("\n");
        } else {
          // 输入和错误通知任务原子保存，引用的 submission 必然已存在。
          const submission = (await harness.submission(
            task.input.id,
            context,
          ))!;
          const settled = await submission.wait(context);
          if (
            settled.status === "unanswered" &&
            settled.reason !== "aborted" &&
            settled.reason !== "reset"
          ) {
            const error = settled.detail ?? settled.reason;
            text = typeof error === "string" ? error : JSON.stringify(error);
          }
        }
        const chunks =
          task.input.kind === "answer" ? formatReply(text) : splitText(text);
        await runtime.commit(async (tx) => {
          const ingress = await tx.doc(Ingress, runtime.conversationId);
          // 在进入发送阶段的原子检查点判断时效；开始发送后不追溯撤回。
          return chunks.length === 0 || ingress.latest !== task.input.through
            ? {
                status: "terminal",
                outcome: { status: "completed", result: null },
              }
            : {
                status: "running",
                checkpoint: { phase: "send", chunks, next: 0 },
              };
        }, context);
      },
      send: async (task, runtime, context) => {
        const state = task.state.checkpoint;
        const chunk = state.chunks[state.next];
        if (chunk !== undefined)
          await send(
            runtime.conversationId,
            task.input,
            // 已保存的旧发送检查点仍是纯文本，不迁移或重新解析它。
            typeof chunk === "string" ? { text: chunk, entities: [] } : chunk,
            runtime.signal,
          );
        await runtime.commit(
          () =>
            state.next + 1 >= state.chunks.length
              ? {
                  status: "terminal",
                  outcome: { status: "completed", result: null },
                }
              : {
                  status: "running",
                  checkpoint: { ...state, next: state.next + 1 },
                },
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
}
