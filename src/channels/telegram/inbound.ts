import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineEntry,
  defineTask,
  type Harness,
  type SubmissionId,
  type Task,
  type TaskId,
} from "@earendil-works/pi-durable";
import {
  DEFAULT_IMAGE_LIMITS,
  type ImageLimits,
} from "@earendil-works/pi-durable/tools";
import { z } from "zod";
import type { DeliveryTask } from "./delivery";

export type Destination = { chatId: number; threadId: number | null };
export type InputSource = Destination & { through: SubmissionId };
export type ReceivedMessage = {
  text: string;
  photo: string | null;
};
export const Received = defineEntry<ReceivedMessage>(
  "amadeus.telegram.received",
);
export const TelegramInput = defineEntry<InputSource>("amadeus.telegram.input");
export const Ingress = defineDoc<{
  collecting: { id: TaskId<null>; until: number } | null;
  tail: TaskId<null> | null;
  latest: SubmissionId | null;
}>({
  kind: "amadeus.telegram.ingress",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ collecting: null, tail: null, latest: null }),
  checkpointWhen: () => true,
});
export const BatchMessages = defineDoc<{ receipts: SubmissionId[] }>({
  kind: "amadeus.telegram.batch",
  version: 1,
  scope: "task",
  initial: () => ({ receipts: [] }),
  checkpointWhen: () => true,
});

type BatchInput = Destination & {
  until: number;
  after: TaskId<null> | null;
};
type BatchState = { phase: "collect" } | { phase: "prepare" };
export type BatchTask = Task<BatchInput, BatchState, null, object>;
export type LoadPhoto = (
  fileId: string,
  limits: ImageLimits,
  signal: AbortSignal,
) => Promise<ImageContent>;

export function createBatchTask(
  harness: Harness,
  delivery: DeliveryTask,
  loadPhoto: LoadPhoto,
): BatchTask {
  return defineTask<BatchInput, BatchState, null>({
    name: "amadeus.telegram.collect",
    version: 1,
    initial: () => ({ phase: "collect" }),
    phases: {
      collect: async (task, runtime, context) => {
        if (runtime.now() < task.input.until) {
          await runtime.sleepUntil(
            task.input.until,
            { phase: "collect" },
            context,
          );
          return;
        }
        await runtime.commit(async (tx) => {
          const ingress = await tx.doc(Ingress, runtime.conversationId);
          if (ingress.collecting?.id === task.id) ingress.collecting = null;
          const checkpoint = { phase: "prepare" } satisfies BatchState;
          // 只串行化入站批次，防止慢图片下载使后批消息先进入模型。
          return task.input.after === null
            ? { status: "running", checkpoint }
            : {
                status: "waiting",
                checkpoint,
                on: [task.input.after],
                policy: "allSettled",
              };
        }, context);
      },
      prepare: async (task, runtime, context) => {
        // 文档与首条收据在创建任务的事务中保存，收集结束后不再追加。
        const { receipts } = (await runtime.snapshot(
          BatchMessages,
          task.id,
          context,
        ))!;
        const source: InputSource = {
          chatId: task.input.chatId,
          threadId: task.input.threadId,
          // 每个批次在创建时已原子写入至少一条收据。
          through: receipts.at(-1)!,
        };
        const content: (TextContent | ImageContent)[] = [];
        for (const id of receipts) {
          // 收据由入站事务创建，任务不会引用尚未保存的 submission。
          const receipt = (await harness.submission(id, context))!;
          const settled = await receipt.wait(context);
          if (settled.type !== "write" || settled.status !== "done")
            throw settled;
          // write 的条目和收据原子保存，且当前实现不删除条目。
          const message = (await runtime.entry(
            Received,
            settled.entry,
            context,
          ))!.data;
          content.push({ type: "text", text: message.text });
          if (message.photo !== null) {
            const ref = (await runtime.agent(context)).model;
            const model = ref
              ? runtime.models.getModel(ref.provider, ref.modelId)
              : undefined;
            const resize = model?.inputLimits?.images?.resize;
            try {
              z.literal(true).parse(model?.input.includes("image"));
              content.push(
                await loadPhoto(
                  message.photo,
                  {
                    maxWidth: resize?.maxWidth ?? DEFAULT_IMAGE_LIMITS.maxWidth,
                    maxHeight:
                      resize?.maxHeight ?? DEFAULT_IMAGE_LIMITS.maxHeight,
                    maxBytes: resize?.maxBytes ?? DEFAULT_IMAGE_LIMITS.maxBytes,
                  },
                  runtime.signal,
                ),
              );
            } catch (error) {
              runtime.signal.throwIfAborted();
              runtime.report(error);
              const detail = error instanceof Error ? error.message : error;
              const text =
                typeof detail === "string"
                  ? detail
                  : (JSON.stringify(detail) ?? String(detail));
              await runtime.commit(async (tx) => {
                await tx.createTask(
                  delivery,
                  { ...source, kind: "error", text },
                  {
                    ownership: { kind: "conversation" },
                    background: true,
                  },
                );
                const ingress = await tx.doc(Ingress, runtime.conversationId);
                if (ingress.tail === task.id) ingress.tail = null;
                return {
                  status: "terminal",
                  outcome: { status: "failed", error: { message: text } },
                };
              }, context);
              return;
            }
          }
          runtime.signal.throwIfAborted();
        }
        // 当前任务归属的会话已持久化，且应用没有删除会话的路径。
        const conversation = (await runtime.conversation(
          runtime.conversationId,
          context,
        ))!;
        await runtime.commit(async (tx) => {
          const id = await conversation.submit(tx, {
            type: "input",
            content,
            whenBusy: "steer",
            requestId: `telegram:batch:${task.id}`,
            entry: { kind: TelegramInput.kind, data: source },
          });
          await tx.createTask(
            delivery,
            { ...source, kind: "failure", id },
            {
              ownership: { kind: "conversation" },
              background: true,
            },
          );
          const ingress = await tx.doc(Ingress, runtime.conversationId);
          if (ingress.tail === task.id) ingress.tail = null;
          return {
            status: "terminal",
            outcome: { status: "completed", result: null },
          };
        }, context);
      },
    },
    abort: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const ingress = await tx.doc(Ingress, runtime.conversationId);
        if (ingress.collecting?.id === task.id) ingress.collecting = null;
        if (ingress.tail === task.id) ingress.tail = null;
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context);
    },
  });
}
