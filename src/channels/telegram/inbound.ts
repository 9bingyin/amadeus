import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineEntry,
  defineTask,
  type Harness,
  type JsonObject,
  type SubmissionId,
  type Task,
  type TaskId,
} from "@earendil-works/pi-durable";
import {
  DEFAULT_IMAGE_LIMITS,
  type ImageLimits,
} from "@earendil-works/pi-durable/tools";
import type { Upload } from "../uploads";
import type { AttachmentLoader } from "./attachments";
import type { DeliveryTask } from "./delivery";
import type { RemoteFile } from "./metadata";

export type Destination = { chatId: number; threadId: number | null };
export type InputSource = Destination & { through: SubmissionId };
export type ReceivedMessage =
  | {
      text: string;
      mode: "content" | "service" | "command";
      metadata: JsonObject;
      files: RemoteFile[];
    }
  | {
      // 已持久化的旧收据仍可被原生待处理任务读取，不迁移历史条目。
      text: string;
      photo: string | null;
    };
export const Received = defineEntry<ReceivedMessage>(
  "amadeus.telegram.received",
);
export const Uploaded = defineEntry<{ source: SubmissionId; files: Upload[] }>(
  "amadeus.telegram.uploads",
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
export function createBatchTask(
  harness: Harness,
  delivery: DeliveryTask,
  attachments: AttachmentLoader,
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
        const uploads: { source: SubmissionId; files: Upload[] }[] = [];
        const ref = (await runtime.agent(context)).model;
        const model = ref
          ? runtime.models.getModel(ref.provider, ref.modelId)
          : undefined;
        const resize = model?.inputLimits?.images?.resize;
        const limits: ImageLimits | undefined = model?.input.includes("image")
          ? {
              maxWidth: resize?.maxWidth ?? DEFAULT_IMAGE_LIMITS.maxWidth,
              maxHeight: resize?.maxHeight ?? DEFAULT_IMAGE_LIMITS.maxHeight,
              maxBytes: resize?.maxBytes ?? DEFAULT_IMAGE_LIMITS.maxBytes,
            }
          : undefined;
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
          const files: RemoteFile[] = "files" in message ? message.files : [];
          if ("photo" in message && message.photo)
            files.push({
              fileId: message.photo,
              name: "photo.jpg",
              mimeType: "image/jpeg",
              size: null,
            });
          const saved: Upload[] = [];
          const images: ImageContent[] = [];
          try {
            for (const [index, file] of files.entries()) {
              const upload = await attachments.load(
                file,
                runtime.conversationId,
                `${id}-${index}`,
                runtime.signal,
              );
              saved.push(upload);
              if (upload.mimeType.startsWith("image/") && limits) {
                const image = await attachments.image(
                  upload,
                  limits,
                  runtime.signal,
                );
                if (image) images.push(image);
              }
            }
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
          const listing = saved.length
            ? `\n\n<attachments>\n${JSON.stringify(saved)}\n</attachments>`
            : "";
          content.push(
            { type: "text", text: message.text + listing },
            ...images,
          );
          if (saved.length) uploads.push({ source: id, files: saved });
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
          // 入站、附件清单及任务状态在同一事务中提交；admission 必须在首次表写入前。
          for (const upload of uploads)
            await tx.appendEntry(Uploaded, conversation.id, { data: upload });
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
