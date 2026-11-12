import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  defineDoc,
  defineDocFamily,
  defineExtension,
  wrapTool,
  type Harness,
  type TaskId,
} from "@earendil-works/pi-durable";
import {
  createBashTool,
  type BashPrepare,
} from "@earendil-works/pi-durable/tools";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, link, lstat, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Agent } from "../../agent";
import type { Channel } from "..";
import { NotificationTask } from "../notifications";
import { notificationSchema } from "./protocol";
const Capability = defineDoc<{ digest: string | null; epoch: string | null }>({
  kind: "amadeus.ipc.capability",
  version: 1,
  scope: "task",
  initial: () => ({ digest: null, epoch: null }),
  checkpointWhen: () => true,
});
const Receipt = defineDocFamily<{ notification: TaskId<null> | null }, null>({
  kind: "amadeus.ipc.receipt",
  version: 1,
  family: true,
  scope: "task",
  initial: () => ({ notification: null }),
  checkpointWhen: () => true,
});

function digest(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
async function statIfExists(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}

export function createIpcExtension(stateDirectory: string) {
  const directory = join(stateDirectory, "ipc");
  const socket = join(directory, "notify.sock");
  const epoch = randomBytes(32).toString("hex");
  const prepare: BashPrepare = async (execution, api, context) => {
    const token = randomBytes(32).toString("hex");
    await api.commit(async (tx) => {
      const capability = await tx.doc(Capability, api.taskId);
      capability.digest = digest(token);
      capability.epoch = epoch;
    }, context);
    Object.assign(execution.env, {
      AMADEUS_NOTIFY_SOCKET: socket,
      AMADEUS_NOTIFY_TOKEN: `${api.taskId}.${token}`,
      AMADEUS_NOTIFY_CLI: fileURLToPath(
        new URL("./client.ts", import.meta.url),
      ),
    });
  };

  return {
    prepare,
    extension: defineExtension({
      name: "amadeus.ipc",
      wraps: [wrapTool(createBashTool(), () => createBashTool({ prepare }))],
    }),
    // 调用方先取得应用目录锁；只有持锁宿主可以清理旧 socket。
    async open(harness: Harness) {
      const context = BACKGROUND_CONTEXT;
      const existing = await statIfExists(directory);
      if (existing) z.literal(true).parse(existing.isDirectory());
      else await mkdir(directory, { mode: 0o700 });
      await chmod(directory, 0o700);
      const stale = await statIfExists(socket);
      if (stale) {
        z.literal(true).parse(stale.isSocket());
        await unlink(socket);
      }
      await using resources = new AsyncDisposableStack();
      const pending = new Set<Promise<Response>>();
      let closing = false;
      async function handle(request: Request): Promise<Response> {
        if (new URL(request.url).pathname !== "/notify")
          return new Response(null, { status: 404 });
        if (request.method !== "POST")
          return new Response(null, {
            status: 405,
            headers: { allow: "POST" },
          });
        const match = /^Bearer ([1-9]\d*)\.([a-f0-9]{64})$/.exec(
          request.headers.get("authorization") ?? "",
        );
        const number = Number(match?.[1]);
        const token = match?.[2];
        if (!token || !Number.isSafeInteger(number))
          return new Response(null, { status: 401 });
        // 经过正安全整数校验的协议 ID 对应原生 TaskId。
        const source = number as TaskId;
        const capability = await harness.snapshot(Capability, source, context);
        const hashed = digest(token);
        if (
          !capability?.digest ||
          capability.epoch !== epoch ||
          !timingSafeEqual(Buffer.from(capability.digest), Buffer.from(hashed))
        )
          return new Response(null, { status: 401 });
        let body: unknown;
        try {
          body = await request.json();
        } catch (error) {
          return new Response(Bun.inspect(error), {
            status: closing && request.signal.aborted ? 499 : 400,
          });
        }
        const parsed = notificationSchema.safeParse(body);
        if (!parsed.success)
          return Response.json(parsed.error, { status: 422 });
        return harness.commit(async (tx) => {
          const task = await tx.task(source);
          if (!task || task.abortRequested || task.state.status !== "running")
            return new Response(null, { status: 410 });
          const grant = await tx.doc(Capability, source);
          if (grant.epoch !== epoch || grant.digest !== hashed)
            return new Response(null, { status: 401 });
          const receipt = await tx.doc(
            Receipt,
            source,
            parsed.data.eventKey,
            null,
          );
          const duplicate = receipt.notification !== null;
          receipt.notification ??= await tx.createTask(
            NotificationTask,
            { ...parsed.data, sourceTask: source, metadata: { source: "ipc" } },
            {
              ownership: { kind: "conversation" },
              conversationId: task.conversationId,
              background: true,
            },
          );
          return Response.json(
            {
              status: duplicate ? "duplicate" : "accepted",
              notificationId: receipt.notification,
            },
            { status: duplicate ? 200 : 202 },
          );
        }, context);
      }
      // Bun.stop 会直接 unlink 绑定路径，独立临时路径避免误删公开路径的替换文件。
      const bound = join(
        directory,
        `.notify-${randomBytes(6).toString("hex")}`,
      );
      const server = Bun.serve({
        unix: bound,
        fetch(request) {
          const response = handle(request);
          pending.add(response);
          void response.then(
            () => pending.delete(response),
            () => pending.delete(response),
          );
          return response;
        },
        error(error) {
          console.error(error);
          return new Response(Bun.inspect(error), { status: 500 });
        },
      });
      let identity: Awaited<ReturnType<typeof lstat>> | undefined;
      resources.defer(async () => {
        closing = true;
        const stopped = server.stop(true);
        await Promise.allSettled([...pending]);
        await stopped;
        const current = await statIfExists(socket);
        if (
          identity &&
          current?.dev === identity.dev &&
          current.ino === identity.ino
        )
          await unlink(socket);
      });
      identity = await lstat(bound);
      await chmod(bound, 0o600);
      await link(bound, socket);
      await unlink(bound);
      const cleanup = resources.move();
      let closed: Promise<void> | undefined;
      return { close: () => (closed ??= cleanup.disposeAsync()) };
    },
  };
}

export async function openIpc(agent: Agent): Promise<Channel> {
  const ipc = createIpcExtension(agent.stateDirectory);
  await using resources = new AsyncDisposableStack();
  resources.defer(() => agent.registry.uninstall(ipc.extension));
  const server = await ipc.open(agent.harness);
  resources.defer(() => server.close());
  agent.registry.install(ipc.extension);
  const cleanup = resources.move();
  return {
    async run(signal) {
      try {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        await cleanup.disposeAsync();
      }
    },
  };
}
