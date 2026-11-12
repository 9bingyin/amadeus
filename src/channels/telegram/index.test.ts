import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  getCurrentSystemPrompt,
  type TextContent,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { contentText } from "@earendil-works/pi-ai/utils/text";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  AssistantEntry,
  CompactionEntry,
  CompactionTask,
  defineExtension,
  defineTool,
  hook,
  ToolTask,
  type Registry,
} from "@earendil-works/pi-durable";
import { Bot } from "grammy";
import type { Message, Update, UserFromGetMe } from "grammy/types";
import { mkdir, mkdtemp, readdir, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z, ZodError } from "zod";
import { openAgent, type Agent } from "../../agent";
import { listSchedules } from "../../agent/schedule";
import { CONTROLLER_KIND } from "../../agent/schedule/runtime";
import {
  readPlanMeta,
  readScheduleFile,
  writePlanMeta,
} from "../../agent/schedule/files";
import { parseConfig, telegramConfigSchema } from "../../config";
import { openIpc } from "../ipc";
import { NotificationEntry, NotificationTask } from "../notifications";
import type { Channel } from "..";
import { configureTelegram, runTelegram, type TelegramOutput } from ".";
import { TelegramState } from "./conversations";
import type { DeliveryTask } from "./delivery";
import { ProgressMessage, toolProgressLine } from "./progress";
import { createSendFileTool } from "./send-file";
import * as replyStreaming from "./streaming";
import {
  BatchMessages,
  Ingress,
  Received,
  TelegramInput,
  Uploaded,
  type BatchTask,
} from "./inbound";

const botInfo = {
  id: 999,
  is_bot: true,
  first_name: "Amadeus",
  username: "test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
} satisfies UserFromGetMe;
const entitySchema = z.looseObject({
  type: z.string(),
  offset: z.number(),
  length: z.number(),
});
const messageSchema = z.object({
  chat_id: z.number(),
  text: z.string(),
  message_thread_id: z.number().optional(),
  entities: z.array(entitySchema).optional(),
});
const actionSchema = z.object({
  chat_id: z.number(),
  action: z.literal("typing"),
  message_thread_id: z.number().optional(),
});
type ChatAction = z.infer<typeof actionSchema>;
type SentMessage = z.infer<typeof messageSchema>;
type SentFile = {
  chat_id: number;
  message_thread_id?: number;
  message_id: number;
  kind: "document" | "photo";
  name: string;
  caption: string;
  bytes: Uint8Array;
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function update(
  id: number,
  text: string,
  userId = 1,
  group = false,
  isBot = false,
  threadId?: number,
): Update {
  const command = text.startsWith("/") ? text.split(/\s/, 1)[0] : undefined;
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1,
      chat: group
        ? { id: -1, type: "group", title: "Group" }
        : { id: userId, type: "private", first_name: "User" },
      from: { id: userId, is_bot: isBot, first_name: "User" },
      text,
      ...(threadId === undefined
        ? {}
        : { message_thread_id: threadId, is_topic_message: true }),
      ...(command
        ? {
            entities: [
              { type: "bot_command", offset: 0, length: command.length },
            ],
          }
        : {}),
    },
  };
}

function messageUpdate(id: number, body: Partial<Message>): Update {
  return {
    update_id: id,
    message: {
      ...body,
      message_id: id,
      date: 1,
      chat: { id: 1, type: "private", first_name: "User" },
      from: { id: 1, is_bot: false, first_name: "User" },
    },
  };
}

function photoUpdate(id: number, caption = ""): Update {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1,
      chat: { id: 1, type: "private", first_name: "User" },
      from: { id: 1, is_bot: false, first_name: "User" },
      photo: [
        {
          file_id: `small-${id}`,
          file_unique_id: `small-${id}`,
          width: 1,
          height: 1,
        },
        {
          file_id: `photo-${id}`,
          file_unique_id: `photo-${id}`,
          width: 16,
          height: 16,
        },
      ],
      caption,
      media_group_id: "album",
    },
  };
}

function attachmentText(id: number, text = ""): TextContent {
  return {
    type: "text",
    text: expect.stringContaining(
      inputText(id, text).text + "\n\n<attachments>",
    ),
  };
}

function inputText(id: number, text = ""): TextContent {
  return {
    type: "text",
    text: `[Telegram #${id} User id:1 Thu 1970-01-01 00:00:01Z]${text ? ` ${text}` : ""}`,
  };
}

async function fixture(
  inputWindowMs = 0,
  imageInput = true,
  streaming = false,
  tokensPerSecond = 0,
) {
  const directory = await mkdtemp(join(tmpdir(), "amadeus-test-"));
  const config = parseConfig(
    {
      channels: {
        telegram: {
          token: "123:TEST",
          allowedUserIds: [1, 2],
          inputWindowMs,
          streaming,
        },
      },
      agent: { model: { provider: "openai", modelId: "test" } },
      providers: { openai: { apiKey: "test-key" } },
    },
    directory,
  );
  const telegram = telegramConfigSchema.parse(config.channels.telegram);
  const faux = fauxProvider({
    provider: "openai",
    models: [{ id: "test", input: imageInput ? ["text", "image"] : ["text"] }],
    ...(tokensPerSecond > 0
      ? { tokensPerSecond, tokenSize: { min: 1, max: 1 } }
      : {}),
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const sent: SentMessage[] = [];
  const actions: ChatAction[] = [];
  const downloads: string[] = [];
  const notifications: (SentMessage & {
    message_id: number;
    disable_notification: true;
    link_preview_options: { is_disabled: true };
  })[] = [];
  const edits: { chat_id: number; message_id: number; text: string }[] = [];
  const deletions: { chat_id: number; message_ids: number[] }[] = [];
  const events: string[] = [];
  const drafts: (SentMessage & { draft_id: number })[] = [];
  const uploads: SentFile[] = [];
  const uploadAttempts: SentFile[] = [];
  let beforeUpload:
    | ((file: SentFile, signal: AbortSignal) => Promise<Response | void>)
    | undefined;
  let beforeDraft:
    | ((
        message: SentMessage & { draft_id: number },
        signal: AbortSignal,
      ) => Promise<Response | void>)
    | undefined;
  let beforeProgress:
    | ((method: string, signal: AbortSignal) => Promise<Response | void>)
    | undefined;
  let beforeSend:
    ((message: SentMessage, signal: AbortSignal) => Promise<void>) | undefined;
  let onSent: ((message: SentMessage) => void) | undefined;
  let onAction: ((action: ChatAction) => void) | undefined;
  let beforePhoto:
    ((signal: AbortSignal) => Promise<Response | void>) | undefined;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/sendChatAction")) {
        const action = actionSchema.parse(await request.json());
        actions.push(action);
        onAction?.(action);
        return Response.json({ ok: true, result: true });
      }
      if (path.endsWith("/getFile")) {
        const { file_id } = z
          .object({ file_id: z.string() })
          .parse(await request.json());
        downloads.push(file_id);
        return Response.json({
          ok: true,
          result: {
            file_id,
            file_unique_id: file_id,
            file_path: `photos/${file_id}.png`,
          },
        });
      }
      if (path.startsWith("/file/")) {
        const response = await beforePhoto?.(request.signal);
        return (
          response ??
          new Response(
            Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
              "base64",
            ),
            {
              headers: { "content-type": "image/png" },
            },
          )
        );
      }
      const method = path.split("/").at(-1);
      if (method === "sendDocument" || method === "sendPhoto") {
        const form = await request.formData();
        const kind = method === "sendPhoto" ? "photo" : "document";
        const reference = z.string().parse(form.get(kind));
        const file = z
          .instanceof(File)
          .parse(form.get(reference.replace("attach://", "")));
        const payload: SentFile = {
          chat_id: Number(form.get("chat_id")),
          ...(form.has("message_thread_id")
            ? { message_thread_id: Number(form.get("message_thread_id")) }
            : {}),
          message_id: 30_000 + uploadAttempts.length,
          kind,
          name: file.name,
          caption: String(form.get("caption") ?? ""),
          bytes: new Uint8Array(await file.arrayBuffer()),
        };
        uploadAttempts.push(payload);
        const response = await beforeUpload?.(payload, request.signal);
        if (response) return response;
        if (request.signal.aborted) return new Response(null, { status: 499 });
        uploads.push(payload);
        events.push("file");
        const telegramFile = {
          file_id: "sent",
          file_unique_id: "sent",
          file_name: payload.name,
          file_size: payload.bytes.length,
        };
        return Response.json({
          ok: true,
          result: {
            message_id: payload.message_id,
            date: 1,
            chat: { id: payload.chat_id, type: "private", first_name: "User" },
            ...(payload.message_thread_id === undefined
              ? {}
              : { message_thread_id: payload.message_thread_id }),
            caption: payload.caption,
            ...(kind === "photo"
              ? { photo: [{ ...telegramFile, width: 1, height: 1 }] }
              : { document: telegramFile }),
          },
        });
      }
      const body: unknown = await request.json();
      if (method === "sendMessageDraft") {
        const payload = messageSchema
          .extend({ draft_id: z.int().positive() })
          .parse(body);
        const response = await beforeDraft?.(payload, request.signal);
        if (response) return response;
        if (request.signal.aborted) return new Response(null, { status: 499 });
        drafts.push(payload);
        events.push("draft");
        return Response.json({ ok: true, result: true });
      }
      if (method === "editMessageText" || method === "deleteMessages") {
        const response = await beforeProgress?.(method, request.signal);
        if (response) return response;
        if (request.signal.aborted) return new Response(null, { status: 499 });
        if (method === "deleteMessages") {
          const payload = z
            .object({ chat_id: z.number(), message_ids: z.array(z.number()) })
            .parse(body);
          deletions.push(payload);
          events.push("delete");
          return Response.json({ ok: true, result: true });
        }
        const payload = z
          .object({
            chat_id: z.number(),
            message_id: z.number(),
            text: z.string(),
          })
          .parse(body);
        edits.push(payload);
        events.push("edit");
        return Response.json({
          ok: true,
          result: {
            message_id: payload.message_id,
            date: 1,
            chat: { id: payload.chat_id, type: "private", first_name: "User" },
            text: payload.text,
          },
        });
      }
      const notification = messageSchema
        .extend({
          disable_notification: z.literal(true),
          link_preview_options: z.object({ is_disabled: z.literal(true) }),
        })
        .safeParse(body);
      if (notification.success) {
        const response = await beforeProgress?.("sendMessage", request.signal);
        if (response) return response;
        if (request.signal.aborted) return new Response(null, { status: 499 });
        const payload = {
          ...notification.data,
          message_id: 10_000 + notifications.length,
        };
        notifications.push(payload);
        events.push("progress");
        return Response.json({
          ok: true,
          result: {
            message_id: payload.message_id,
            date: 1,
            chat: { id: payload.chat_id, type: "private", first_name: "User" },
            text: payload.text,
          },
        });
      }
      const payload = messageSchema.parse(body);
      await beforeSend?.(payload, request.signal);
      if (request.signal.aborted) return new Response(null, { status: 499 });
      sent.push(payload);
      events.push("answer");
      onSent?.(payload);
      return Response.json({
        ok: true,
        result: {
          message_id: sent.length,
          date: 1,
          chat: { id: payload.chat_id, type: "private", first_name: "User" },
          text: payload.text,
        },
      });
    },
  });
  let agent: Agent;
  let bot: Bot;
  let progress: TelegramOutput;
  let ipc: Channel | undefined;
  async function open(botId = botInfo.id): Promise<void> {
    const next = await openAgent(config, models);
    const client = new Bot(telegram.token, {
      botInfo: { ...botInfo, id: botId },
      client: { apiRoot: server.url.origin },
    });
    try {
      progress = await configureTelegram(client, next, telegram);
      ipc = await openIpc(next);
    } catch (error) {
      await progress?.close();
      await next.close();
      throw error;
    }
    agent = next;
    bot = client;
    agent.harness.resume();
  }
  cleanups.push(async () => {
    try {
      await ipc?.run(AbortSignal.abort());
      await progress?.close();
      await agent?.close();
    } finally {
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });
  await open();
  return {
    config,
    models,
    faux,
    sent,
    actions,
    downloads,
    notifications,
    edits,
    deletions,
    events,
    drafts,
    uploads,
    uploadAttempts,
    beforeUpload(handler?: typeof beforeUpload) {
      beforeUpload = handler;
    },
    beforeDraft(handler?: typeof beforeDraft) {
      beforeDraft = handler;
    },
    beforeProgress(handler?: typeof beforeProgress) {
      beforeProgress = handler;
    },
    flushProgress: () => progress.flush(),
    get agent() {
      return agent;
    },
    get bot() {
      return bot;
    },
    get api() {
      return bot.api;
    },
    get registry(): Registry {
      return agent.registry;
    },
    get images() {
      return agent.images;
    },
    get harness() {
      return agent.harness;
    },
    open,
    close: async () => {
      await ipc?.run(AbortSignal.abort());
      await progress.close();
      await agent.close();
    },
    receive: (incoming: Update) => bot.handleUpdate(incoming),
    async entries() {
      const state = await agent.harness.snapshot(
        TelegramState,
        BACKGROUND_CONTEXT,
      );
      const pages = await Promise.all(
        Object.values(state?.chats ?? {}).map((id) =>
          agent.harness.commit(
            (tx) =>
              tx.scanEntries({ conversationId: id, order: "ascending" }, 512),
            BACKGROUND_CONTEXT,
          ),
        ),
      );
      return pages.flatMap((page) => page.items);
    },
    beforeSend(handler?: typeof beforeSend) {
      beforeSend = handler;
    },
    onSent(handler: NonNullable<typeof onSent>) {
      onSent = handler;
    },
    onAction(handler: NonNullable<typeof onAction>) {
      onAction = handler;
    },
    beforePhoto(handler?: typeof beforePhoto) {
      beforePhoto = handler;
    },
    async prepare() {
      const inspection = await agent.harness.inspect(BACKGROUND_CONTEXT);
      await Promise.all(
        inspection.tasks
          .filter(({ record }) => record.kind === "amadeus.telegram.collect")
          .map(({ record }) =>
            agent.harness.waitForTask(record.id, BACKGROUND_CONTEXT),
          ),
      );
    },
    async flush() {
      await agent.harness.waitForIdle(BACKGROUND_CONTEXT);
      const inspection = await agent.harness.inspect(BACKGROUND_CONTEXT);
      await Promise.all(
        inspection.tasks
          .filter(({ record }) => record.kind.startsWith("amadeus.telegram."))
          .map(({ record }) =>
            agent.harness.waitForTask(record.id, BACKGROUND_CONTEXT),
          ),
      );
      await progress.flush();
    },
  };
}

test.each([false, true])(
  "Delivers worker reports to the original topic only when requested, notify=%s",
  async (notify) => {
    const f = await fixture();
    f.faux.setResponses(
      Array.from({ length: 8 }, () => (request) => {
        if (
          getCurrentSystemPrompt(request.messages).includes(
            "<scheduled_worker>",
          )
        )
          return notify
            ? fauxAssistantMessage(
                fauxToolCall("schedule_result", {
                  notify: true,
                  message: "A new service issue was found",
                }),
                { stopReason: "toolUse" },
              )
            : fauxAssistantMessage("Check completed; no new issues.");
        const last = request.messages.findLast(
          (message) => message.role !== "system",
        );
        if (last?.role === "toolResult")
          return fauxAssistantMessage("Check scheduled");
        if (contentText(last?.content ?? []).startsWith("[Schedule "))
          return fauxAssistantMessage("A new service issue needs attention.");
        return fauxAssistantMessage(
          fauxToolCall("schedule", {
            action: "create",
            name: "Service check",
            prompt: "Check the service and report only new issues",
            when: { kind: "after", delayMs: 0 },
          }),
          { stopReason: "toolUse" },
        );
      }),
    );
    await f.receive(update(1, "Schedule a service check", 1, false, false, 7));
    await f.prepare();
    await f.harness.waitForIdle(BACKGROUND_CONTEXT);
    const plans = await f.harness.commit(
      (tx) => tx.scanTasks({ kind: CONTROLLER_KIND }, 100),
      BACKGROUND_CONTEXT,
    );
    for (const task of plans.items)
      await f.harness.waitForTask(task.id, BACKGROUND_CONTEXT);
    const notifications = await f.harness.commit(
      (tx) => tx.scanTasks({ kind: NotificationTask.definition.name }, 100),
      BACKGROUND_CONTEXT,
    );
    for (const task of notifications.items)
      await f.harness.waitForTask(task.id, BACKGROUND_CONTEXT);
    await f.flush();
    expect(f.sent.map(({ text }) => text)).toEqual(
      notify
        ? ["Check scheduled", "A new service issue needs attention."]
        : ["Check scheduled"],
    );
    expect(f.sent.every((message) => message.message_thread_id === 7)).toBe(
      true,
    );
    expect(f.faux.state.callCount).toBe(notify ? 4 : 3);
  },
);

test("Delivers scheduled stdout to the original topic without IPC calls", async () => {
  const f = await fixture();
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("schedule", {
        action: "create",
        name: "Site check",
        command: "printf 'Site issue'; printf 'routine log' >&2",
        when: { kind: "after", delayMs: 0 },
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Check scheduled"),
    (request) => {
      const message = request.messages.findLast(
        (message) => message.role === "user",
      );
      const text = contentText(message?.content ?? []);
      expect(text).toContain("Site issue");
      expect(text).toContain('[Metadata: {"source":"schedule"');
      expect(text).toContain('"name":"Site check"');
      expect(text).toContain('"runner":"command"');
      expect(text).not.toContain("<ipc_notification>");
      expect(text).not.toContain("routine log");
      return fauxAssistantMessage("The site needs attention.");
    },
  ]);
  await f.receive(update(1, "Schedule a check", 1, false, false, 7));
  await f.prepare();
  await f.harness.waitForIdle(BACKGROUND_CONTEXT);
  const schedules = await f.harness.commit(
    (tx) => tx.scanTasks({ kind: CONTROLLER_KIND }, 100),
    BACKGROUND_CONTEXT,
  );
  expect(schedules.items).toHaveLength(1);
  for (const task of schedules.items)
    await f.harness.waitForTask(task.id, BACKGROUND_CONTEXT);
  const notifications = await f.harness.commit(
    (tx) => tx.scanTasks({ kind: NotificationTask.definition.name }, 100),
    BACKGROUND_CONTEXT,
  );
  for (const task of notifications.items)
    await f.harness.waitForTask(task.id, BACKGROUND_CONTEXT);
  await f.flush();
  expect(f.sent.map(({ text }) => text)).toEqual([
    "Check scheduled",
    "The site needs attention.",
  ]);
  expect(f.sent.every((message) => message.message_thread_id === 7)).toBe(true);
});

test("Delivers IPC follow-up replies to the original Telegram topic", async () => {
  const f = await fixture();
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("bash", {
        command:
          'bun run "$AMADEUS_NOTIFY_CLI" --key changed --message "The check found a new release"',
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Check command finished"),
    (request) => {
      const input = request.messages.findLast(
        (message) => message.role === "user",
      );
      expect(contentText(input?.content ?? [])).toContain(
        "The check found a new release",
      );
      return fauxAssistantMessage("A new release is available. Upgrade?");
    },
  ]);
  await f.receive(update(1, "Run the check", 1, false, false, 7));
  await f.flush();
  expect(f.sent.map(({ text }) => text)).toEqual([
    "Check command finished",
    "A new release is available. Upgrade?",
  ]);
  expect(
    f.sent.every(
      (message) => message.chat_id === 1 && message.message_thread_id === 7,
    ),
  ).toBe(true);
  expect((await f.entries()).filter(NotificationEntry.is)).toHaveLength(1);
});

test("Persists original model failures after IPC notifications", async () => {
  const f = await fixture();
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("bash", {
        command:
          'bun run "$AMADEUS_NOTIFY_CLI" --key failed --message "Check the execution result"',
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Check arranged"),
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "original IPC model failure",
    }),
  ]);
  await f.receive(update(1, "Run the check"));
  await f.flush();
  expect(f.sent.map(({ text }) => text)).toEqual([
    "Check arranged",
    "original IPC model failure",
  ]);
});

test("Does not suppress independent IPC replies while new attachments are pending", async () => {
  const f = await fixture();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const downloading = Promise.withResolvers<void>();
  const photo = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("bash", {
        command:
          'bun run "$AMADEUS_NOTIFY_CLI" --key attention --message "Background check found an issue"',
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Command finished"),
    async () => {
      started.resolve();
      await release.promise;
      return fauxAssistantMessage("A background issue needs attention");
    },
    fauxAssistantMessage("Image received"),
  ]);
  f.beforePhoto(async () => {
    downloading.resolve();
    await photo.promise;
  });
  f.onSent((message) => {
    if (message.text === "A background issue needs attention")
      delivered.resolve();
  });
  try {
    await f.receive(update(1, "Run a check"));
    await started.promise;
    await f.receive(photoUpdate(2));
    await downloading.promise;
    release.resolve();
    await delivered.promise;
    expect(f.sent.map(({ text }) => text)).toEqual([
      "Command finished",
      "A background issue needs attention",
    ]);
    photo.resolve();
    await f.flush();
    expect(f.sent.at(-1)?.text).toBe("Image received");
  } finally {
    release.resolve();
    photo.resolve();
  }
});

test("Shares typing status per topic across input preparation, generation, and delivery", async () => {
  const f = await fixture(700);
  const typing = spyOn(f.api, "sendChatAction");
  const initial = Promise.withResolvers<void>();
  const renewed = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const releaseModel = Promise.withResolvers<void>();
  const sending = Promise.withResolvers<void>();
  const releaseSend = Promise.withResolvers<void>();
  f.onAction(() => {
    if (f.actions.length === 1) initial.resolve();
    if (f.actions.length === 2) renewed.resolve();
  });
  f.faux.setResponses([
    async () => {
      started.resolve();
      await releaseModel.promise;
      return fauxAssistantMessage("Complete reply");
    },
  ]);
  f.beforeSend(async () => {
    sending.resolve();
    await releaseSend.promise;
  });
  try {
    await f.receive(update(1, "First message", 1, false, false, 7));
    await initial.promise;
    expect(f.faux.state.callCount).toBe(0);
    await f.receive(update(2, "Second message", 1, false, false, 7));
    await f.receive(update(2, "Second message", 1, false, false, 7));
    expect(typing).toHaveBeenCalledTimes(1);
    const signal = typing.mock.calls[0]?.[3];
    expect(signal?.aborted).toBe(false);
    await started.promise;
    await renewed.promise;
    expect(f.actions).toEqual([
      { chat_id: 1, action: "typing", message_thread_id: 7 },
      { chat_id: 1, action: "typing", message_thread_id: 7 },
    ]);
    expect(typing.mock.calls[1]?.[3]).toBe(signal);
    releaseModel.resolve();
    await sending.promise;
    expect(signal?.aborted).toBe(false);
    releaseSend.resolve();
    await f.flush();
    expect(signal?.aborted).toBe(true);
    expect(f.faux.state.callCount).toBe(1);
    expect(f.sent.map(({ text }) => text)).toEqual(["Complete reply"]);
  } finally {
    releaseModel.resolve();
    releaseSend.resolve();
    typing.mockRestore();
  }
}, 10_000);

test("Cancels typing on stop and close and restores active work on restart", async () => {
  const f = await fixture(60_000);
  const typing = spyOn(f.api, "sendChatAction");
  let id = 0;
  try {
    for (const command of ["/stop", "/new"]) {
      const shown = Promise.withResolvers<void>();
      f.onAction(() => shown.resolve());
      await f.receive(update(++id, "Awaiting processing", 1, false, false, 7));
      await shown.promise;
      const signal = typing.mock.calls.at(-1)?.[3];
      expect(signal?.aborted).toBe(false);
      await f.receive(update(++id, command, 1, false, false, 7));
      await f.flush();
      expect(signal?.aborted).toBe(true);
    }
    const shown = Promise.withResolvers<void>();
    f.onAction(() => shown.resolve());
    await f.receive(update(++id, "Awaiting recovery", 1, false, false, 7));
    await shown.promise;
    const signal = typing.mock.calls.at(-1)?.[3];
    await f.close();
    expect(signal?.aborted).toBe(true);
    const count = f.actions.length;
    const restored = Promise.withResolvers<void>();
    f.onAction(() => restored.resolve());
    await f.open();
    await restored.promise;
    expect(f.actions.slice(count)).toEqual([
      { chat_id: 1, action: "typing", message_thread_id: 7 },
    ]);
    await f.receive(update(++id, "/stop", 1, false, false, 7));
    await f.flush();
    expect(f.faux.state.callCount).toBe(0);
  } finally {
    typing.mockRestore();
  }
});

test("Keeps typing failures from blocking model replies", async () => {
  const f = await fixture();
  const typing = spyOn(f.api, "sendChatAction");
  const pending = Promise.withResolvers<true>();
  const attempted = Promise.withResolvers<void>();
  const reported = Promise.withResolvers<void>();
  const failure = new TypeError("typing unavailable");
  const original = console.error;
  const reports = spyOn(console, "error").mockImplementation(
    (error: unknown) => {
      if (error === failure) reported.resolve();
      else original(error);
    },
  );
  typing.mockImplementation(() => {
    attempted.resolve();
    return pending.promise;
  });
  f.faux.setResponses([
    async () => {
      await attempted.promise;
      return fauxAssistantMessage(
        "Replies while the status request is pending",
      );
    },
  ]);
  try {
    await f.receive(update(1, "First message"));
    await f.flush();
    expect(f.sent.map(({ text }) => text)).toEqual([
      "Replies while the status request is pending",
    ]);
    expect(typing.mock.calls[0]?.[3]?.aborted).toBe(true);
    pending.resolve(true);
    typing.mockRejectedValue(failure);
    f.faux.setResponses([
      async () => {
        await reported.promise;
        return fauxAssistantMessage("Replies despite a status failure");
      },
    ]);
    await f.receive(update(2, "Second message"));
    await f.flush();
    expect(reports).toHaveBeenCalledWith(failure);
    expect(f.sent.at(-1)?.text).toBe("Replies despite a status failure");
    expect(f.faux.state.callCount).toBe(2);
  } finally {
    attempted.resolve();
    reported.resolve();
    pending.resolve(true);
    typing.mockRestore();
    reports.mockRestore();
  }
});

test("Cancels Telegram startup and preserves startup errors", async () => {
  for (const mode of ["already-aborted", "starting", "failed"]) {
    const bot = new Bot("123:TEST", { botInfo });
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const failure = new TypeError("original Telegram startup failure");
    const commands = spyOn(bot.api, "setMyCommands").mockImplementation(
      async () => {
        entered.resolve();
        if (mode === "failed") throw failure;
        await new Promise<void>((resolve) => {
          if (controller.signal.aborted) resolve();
          else
            controller.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
        });
        throw new DOMException("Aborted", "AbortError");
      },
    );
    const polling = spyOn(bot, "start").mockResolvedValue();
    try {
      if (mode === "already-aborted") controller.abort();
      const running = runTelegram(bot, controller.signal);
      if (mode === "failed") await expect(running).rejects.toBe(failure);
      else {
        if (mode === "starting") {
          await entered.promise;
          controller.abort();
        }
        await running;
      }
      expect(polling).not.toHaveBeenCalled();
      expect(commands).toHaveBeenCalledTimes(
        mode === "already-aborted" ? 0 : 1,
      );
      if (mode !== "already-aborted")
        expect(commands.mock.calls[0]?.[0]).toEqual([
          { command: "new", description: "Reset context" },
          { command: "stop", description: "Stop processing" },
          { command: "compact", description: "Compact context" },
          { command: "schedule", description: "List schedules" },
          { command: "status", description: "Show status" },
        ]);
    } finally {
      controller.abort();
      commands.mockRestore();
      polling.mockRestore();
    }
  }
});

test("Closes a real pending Telegram startup request on host cancellation", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch() {
      entered.resolve();
      await release.promise;
      return Response.json({ ok: true, result: true });
    },
  });
  const controller = new AbortController();
  const bot = new Bot("123:TEST", {
    botInfo,
    client: { apiRoot: server.url.origin },
  });
  const running = runTelegram(bot, controller.signal);
  try {
    await entered.promise;
    controller.abort();
    await running;
  } finally {
    controller.abort();
    release.resolve();
    await Promise.allSettled([running]);
    await server.stop(true);
  }
});

test("Logs accepted messages without duplicating updates or leaking content", async () => {
  const info = spyOn(console, "info").mockImplementation(() => {});
  try {
    const f = await fixture();
    f.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", { command: "printf PRIVATE_TOOL_ARGUMENT" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("PRIVATE_REPLY"),
    ]);
    await f.receive(update(1, "PRIVATE_MESSAGE", 1, false, false, 7));
    await f.receive(update(1, "PRIVATE_MESSAGE", 1, false, false, 7));
    await f.receive(update(2, "PRIVATE_UNAUTHORIZED_MESSAGE", 3));
    await f.flush();
    const lines = info.mock.calls.map(([line]) => String(line));
    expect(
      lines.filter((line) => line.startsWith("Telegram message received:")),
    ).toHaveLength(1);
    expect(
      lines.filter((line) => line.startsWith("Telegram reply sent:")),
    ).toHaveLength(1);
    expect(lines.join("\n")).toContain("chat=1 message=1");
    expect(lines.join("\n")).not.toMatch(/PRIVATE_|123:TEST|test-key/u);
    expect(f.sent.map(({ text }) => text)).toEqual(["PRIVATE_REPLY"]);
  } finally {
    info.mockRestore();
  }
});

test("Accepts only allowlisted private messages from human users", async () => {
  const f = await fixture();
  f.faux.setResponses([fauxAssistantMessage("Received")]);
  await f.receive(update(1, "Allowed message"));
  await f.receive(update(2, "Unauthorized", 3));
  await f.receive(update(3, "Group message", 1, true));
  await f.receive(update(4, "Bot message", 1, false, true));
  await f.receive(update(5, "/compact", 3));
  await f.receive(update(6, "/schedule", 3));
  await f.receive(update(7, "/compact", 1, true));
  await f.flush();
  expect(f.faux.state.callCount).toBe(1);
  expect(f.sent.map((message) => message.text)).toEqual(["Received"]);
  expect(f.actions.every(({ chat_id }) => chat_id === 1)).toBe(true);
});

test("Replies to repeated read-only commands without creating processing tasks", async () => {
  const f = await fixture();
  await f.receive(update(1, "/help", 1, false, false, 7));
  await f.receive(update(1, "/help", 1, false, false, 7));
  await f.receive(update(2, "/status", 1, false, false, 7));
  await f.receive(update(2, "/status", 1, false, false, 7));
  await f.receive(update(3, "/new extra", 1, false, false, 7));
  await f.receive(update(3, "/new extra", 1, false, false, 7));
  await f.receive(update(4, "/schedule", 1, false, false, 7));
  await f.receive(update(4, "/schedule", 1, false, false, 7));
  await f.receive(update(5, "/compact extra", 1, false, false, 7));
  await f.receive(update(5, "/compact extra", 1, false, false, 7));
  await f.receive(update(6, "/unknown"));
  expect(f.sent).toHaveLength(10);
  expect(f.sent[0]?.text).toBe(
    "Send a message or attachment.\n\n/new — Reset context\n/stop — Stop processing\n/compact — Compact context\n/schedule — List schedules\n/status — Show status",
  );
  expect(f.sent[2]?.text).toMatch(
    /^Model: openai\/test\nStatus: Idle\nContext: 0\.0%\/128k\nSession: \d+$/u,
  );
  expect(f.sent.every((message) => message.message_thread_id === 7)).toBe(true);
  expect(f.sent.at(-1)?.text).toBe("This command takes no arguments.");
  expect(f.faux.state.callCount).toBe(0);
  expect(f.actions).toHaveLength(0);
  const tasks = await f.harness.commit(
    (tx) => tx.scanTasks({}, 1),
    BACKGROUND_CONTEXT,
  );
  expect(tasks.items).toHaveLength(0);
});

test("Acknowledges an idle stop without calling the model", async () => {
  const f = await fixture();
  await f.receive(update(1, "/stop"));
  await f.receive(update(1, "/stop"));
  expect(f.sent.map(({ text }) => text)).toEqual(["Nothing to stop."]);
  expect(f.faux.state.callCount).toBe(0);
});

test("Displays current context usage using the selected model's window", async () => {
  const f = await fixture();
  const catalog = fauxProvider({
    provider: "openai",
    models: [
      { id: "test", contextWindow: 500_000 },
      { id: "large", contextWindow: 1_000_000 },
      { id: "unknown", contextWindow: 0 },
    ],
  });
  f.models.setProvider(catalog.provider);
  await f.receive(update(1, "/status"));
  expect(f.sent.at(-1)?.text).toContain("Context: 0.0%/500k");
  const id = (await f.harness.snapshot(TelegramState, BACKGROUND_CONTEXT))
    ?.chats["1:0"];
  if (!id) return z.never().parse(id);
  const conversation = await f.harness.conversation(id, BACKGROUND_CONTEXT);
  if (!conversation) return z.never().parse(conversation);
  // Write persisted provider usage directly so faux estimates cannot overwrite these values.
  for (const tokens of [100_000, 138_000]) {
    const message = fauxAssistantMessage("retained answer");
    message.usage = {
      ...message.usage,
      input: tokens - 1000,
      output: 1000,
      totalTokens: tokens,
    };
    const submission = await conversation.submit(
      { type: "write", entry: { kind: AssistantEntry.kind, model: [message] } },
      BACKGROUND_CONTEXT,
    );
    expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
  }
  await f.receive(update(2, "/status"));
  expect(f.sent.at(-1)?.text).toMatch(
    /^Model: openai\/test\nStatus: Idle\nContext: 27\.6%\/500k\nSession: \d+$/u,
  );
  expect(f.sent.at(-1)?.text).not.toContain("Total usage");
  await conversation.configure(
    { model: { provider: "openai", modelId: "large" } },
    BACKGROUND_CONTEXT,
  );
  await f.receive(update(3, "/status"));
  expect(f.sent.at(-1)?.text).toContain("Context: 13.8%/1.0M");
  await conversation.configure(
    { model: { provider: "openai", modelId: "unknown" } },
    BACKGROUND_CONTEXT,
  );
  await f.receive(update(4, "/status"));
  expect(f.sent.at(-1)?.text).toContain("Context: ?/?");
  await f.close();
  await f.open();
  await f.receive(update(5, "/status"));
  expect(f.sent.at(-1)?.text).toContain("Context: 27.6%/500k");
  await f.receive(update(6, "/new"));
  expect(f.sent.at(-1)?.text).toBe("Context reset.");
  await f.receive(update(7, "/status"));
  expect(f.sent.at(-1)?.text).toContain("Context: ?/500k");
  expect(f.faux.state.callCount).toBe(0);
  expect(catalog.state.callCount).toBe(0);
});

test("Waits for fresh usage after compaction instead of reusing old context measurements", async () => {
  const { f } = await compactionFixture();
  await f.receive(update(4, "/status", 1, false, false, 7));
  expect(f.sent.at(-1)?.text).toMatch(/Context: \d+\.\d%\/128k/u);
  f.faux.setResponses([
    fauxAssistantMessage("## Goal\nPreserve historical facts。"),
  ]);
  await f.receive(update(5, "/compact", 1, false, false, 7));
  await f.flush();
  expect((await f.entries()).filter(CompactionEntry.is)).toHaveLength(1);
  await f.receive(update(6, "/status", 1, false, false, 7));
  expect(f.sent.at(-1)?.text).toContain("Context: ?/128k");
  await f.close();
  await f.open();
  await f.receive(update(7, "/status", 1, false, false, 7));
  expect(f.sent.at(-1)?.text).toContain("Context: ?/128k");
  f.faux.setResponses([() => fauxAssistantMessage("Continue answering.")]);
  await f.receive(update(8, "Continue", 1, false, false, 7));
  await f.flush();
  await f.receive(update(9, "/status", 1, false, false, 7));
  expect(f.sent.at(-1)?.text).toMatch(/Context: \d+\.\d%\/128k/u);
  expect(f.faux.state.callCount).toBe(4);
});

test("Lists only the current topic's active schedules without calling the model", async () => {
  const f = await fixture();
  f.faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("schedule", {
          action: "create",
          name: "Interval check",
          command: "true",
          when: { kind: "every", intervalMs: 1_800_000 },
        }),
        fauxToolCall("schedule", {
          action: "create",
          name: "Daily report",
          prompt: "Generate the daily report",
          when: {
            kind: "cron",
            expression: "0 9 * * *",
            timezone: "Asia/Shanghai",
          },
        }),
        fauxToolCall("schedule", {
          action: "create",
          name: "One-time reminder",
          command: "true",
          when: { kind: "at", at: "2099-01-01T09:00:00+08:00" },
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Scheduled"),
  ]);
  await f.receive(update(1, "Create schedules", 1, false, false, 7));
  await f.flush();
  const state = await f.harness.snapshot(TelegramState, BACKGROUND_CONTEXT);
  const id = state?.chats["1:7"];
  if (!id) return z.never().parse(id);
  const before = await listSchedules(
    f.config.stateDirectory,
    f.harness,
    id,
    BACKGROUND_CONTEXT,
  );
  const calls = f.faux.state.callCount;
  await f.receive(update(2, "/schedule", 1, false, false, 7));
  await f.receive(update(2, "/schedule", 1, false, false, 7));
  await f.receive(update(3, "/schedule", 2, false, false, 7));
  await f.receive(update(4, "/schedule", 1, false, false, 8));
  const sent = f.sent.slice(-4);
  expect(sent[0]?.text).toContain("Interval check · Script\nEvery 30m");
  expect(sent[0]?.text).toContain(
    "Daily report · Agent\nCron 0 9 * * * · Asia/Shanghai",
  );
  expect(sent[0]?.text).toContain("One-time reminder · Script\nOne-time");
  expect(sent[0]?.text).toStartWith("Schedules (3)\n\n");
  expect(sent[0]?.text).toMatch(
    /Next: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/u,
  );
  expect(sent[0]?.text).not.toMatch(/\.\d{3}Z/u);
  expect(sent[0]?.message_thread_id).toBe(7);
  expect(sent[1]?.text).toBe(sent[0]?.text);
  expect(sent[2]?.text).toBe("No schedules.");
  expect(sent[2]?.chat_id).toBe(2);
  expect(sent[3]?.text).toBe("No schedules.");
  expect(sent[3]?.message_thread_id).toBe(8);
  expect(f.faux.state.callCount).toBe(calls);
  const after = await listSchedules(
    f.config.stateDirectory,
    f.harness,
    id,
    BACKGROUND_CONTEXT,
  );
  expect(
    after.map(({ id, meta, definition }) => ({
      id,
      status: meta.status,
      definition,
    })),
  ).toEqual(
    before.map(({ id, meta, definition }) => ({
      id,
      status: meta.status,
      definition,
    })),
  );
  const first = before.find(
    ({ definition }) => definition.name === "Interval check",
  );
  if (!first) return z.never().parse(first);
  const path = first.path;
  await Bun.write(
    path,
    JSON.stringify({
      ...(await readScheduleFile(path)),
      name: "Updated interval",
      when: { kind: "every", intervalMs: 3_600_000 },
    }),
  );
  await f.receive(update(5, "/schedule", 1, false, false, 7));
  expect(f.sent.at(-1)?.text).toContain("Updated interval · Script\nEvery 1h");
  expect(f.sent.at(-1)?.text).toContain(`File: ${path}`);
  expect(f.faux.state.callCount).toBe(calls);
  await writePlanMeta(
    f.config.stateDirectory,
    first.id,
    {
      ...(await readPlanMeta(f.config.stateDirectory, first.id)),
      status: "disabled",
    },
    BACKGROUND_CONTEXT,
  );
  const removed = before.find(
    ({ definition }) => definition.name === "Daily report",
  );
  if (!removed) return z.never().parse(removed);
  await writePlanMeta(
    f.config.stateDirectory,
    removed.id,
    {
      ...(await readPlanMeta(f.config.stateDirectory, removed.id)),
      status: "deleted",
    },
    BACKGROUND_CONTEXT,
  );
  await f.receive(update(6, "/schedule", 1, false, false, 7));
  expect(f.sent.at(-1)?.text).toStartWith("Schedules (2)\n\n");
  expect(f.sent.at(-1)?.text).toContain("Every 1h · Disabled");
  expect(f.sent.at(-1)?.text).not.toContain("Daily report");
  expect(f.faux.state.callCount).toBe(calls);
});

test("Omits completed one-time plans from the schedule command", async () => {
  const f = await fixture();
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("schedule", {
        action: "create",
        name: "Completed",
        command: "true",
        when: { kind: "after", delayMs: 0 },
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Scheduled"),
  ]);
  await f.receive(update(1, "Run once"));
  await f.flush();
  const plans = await f.harness.commit(
    (tx) => tx.scanTasks({ kind: CONTROLLER_KIND }, 100),
    BACKGROUND_CONTEXT,
  );
  expect(plans.items).toHaveLength(1);
  for (const task of plans.items)
    await f.harness.waitForTask(task.id, BACKGROUND_CONTEXT);
  await f.receive(update(2, "/schedule"));
  expect(f.sent.at(-1)?.text).toBe("No schedules.");
  expect(f.faux.state.callCount).toBe(2);
});

test("Splits long schedule lists without interpreting names as Markdown", async () => {
  const f = await fixture();
  const name = "**Literal name**" + "计划".repeat(3000);
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("schedule", {
        action: "create",
        name,
        command: "true",
        when: { kind: "after", delayMs: 86_400_000 },
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Scheduled"),
  ]);
  await f.receive(update(1, "Schedule a long name"));
  await f.flush();
  const start = f.sent.length;
  await f.receive(update(2, "/schedule"));
  const chunks = f.sent.slice(start);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.map(({ text }) => text).join("")).toContain(name);
  expect(
    chunks.every(
      ({ text, entities }) => text.length <= 4096 && !entities?.length,
    ),
  ).toBe(true);
  expect(f.faux.state.callCount).toBe(2);
});

test("Deduplicates compaction commands across restart and rejects arguments", async () => {
  const f = await fixture();
  await f.receive(update(1, "/compact extra", 1, false, false, 7));
  await f.receive(update(1, "/compact extra", 1, false, false, 7));
  await f.receive(update(2, "/compact", 1, false, false, 7));
  await f.flush();
  await f.close();
  await f.open();
  await f.receive(update(2, "/compact", 1, false, false, 7));
  const tasks = await f.harness.commit(
    (tx) => tx.scanTasks({ kind: CompactionTask.definition.name }, 100),
    BACKGROUND_CONTEXT,
  );
  expect(tasks.items).toHaveLength(1);
  expect(tasks.items[0]?.state.outcome?.status).toBe("completed");
  expect(f.faux.state.callCount).toBe(0);
  expect(f.sent.map(({ text }) => text)).toEqual([
    "This command takes no arguments.",
    "This command takes no arguments.",
    "Compaction requested.",
  ]);
  expect(f.sent.every((message) => message.message_thread_id === 7)).toBe(true);
  expect((await f.entries()).filter(CompactionEntry.is)).toHaveLength(0);
});

async function compactionFixture() {
  const f = await fixture();
  await f.receive(update(1, "/help", 1, false, false, 7));
  const id = (await f.harness.snapshot(TelegramState, BACKGROUND_CONTEXT))
    ?.chats["1:7"];
  if (!id) return z.never().parse(id);
  const conversation = await f.harness.conversation(id, BACKGROUND_CONTEXT);
  if (!conversation) return z.never().parse(conversation);
  await conversation.configure(
    { compaction: { enabled: false, keepRecentTokens: 64 } },
    BACKGROUND_CONTEXT,
  );
  f.faux.setResponses([
    fauxAssistantMessage("old answer ".repeat(200)),
    fauxAssistantMessage("recent answer ".repeat(40)),
  ]);
  await f.receive(update(2, "Preserve historical facts", 1, false, false, 7));
  await f.flush();
  await f.receive(update(3, "Continue discussing", 1, false, false, 7));
  await f.flush();
  return { f, conversation };
}

test("Cancels in-flight manual compaction with stop", async () => {
  const { f, conversation } = await compactionFixture();
  const started = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  f.faux.setResponses([
    async (_request, options) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else
          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
      });
      stopped.resolve();
      return fauxAssistantMessage("Summary after cancellation");
    },
  ]);
  await f.receive(update(4, "/compact", 1, false, false, 7));
  await started.promise;
  await f.receive(update(5, "/stop", 1, false, false, 7));
  await stopped.promise;
  await f.flush();
  expect(f.sent.at(-1)?.text).toBe("Stopped.");
  expect((await f.entries()).filter(CompactionEntry.is)).toHaveLength(0);
  const tasks = await f.harness.commit(
    (tx) =>
      tx.scanTasks(
        {
          kind: CompactionTask.definition.name,
          conversationId: conversation.id,
        },
        100,
      ),
    BACKGROUND_CONTEXT,
  );
  expect(tasks.items[0]?.state.outcome?.status).toBe("aborted");
});

test("Preserves compaction errors in status without generating a chat reply", async () => {
  const { f } = await compactionFixture();
  f.faux.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "original summary rejection",
    }),
  ]);
  await f.receive(update(4, "/compact", 1, false, false, 7));
  await f.flush();
  await f.receive(update(5, "/status", 1, false, false, 7));
  expect(f.sent.at(-1)?.text).toContain("original summary rejection");
  expect(f.sent.at(-1)?.text).not.toContain("Compactions:");
  expect(f.faux.state.callCount).toBe(3);
  expect((await f.entries()).filter(CompactionEntry.is)).toHaveLength(0);
});

test("Preserves isolated chat and topic history across restart", async () => {
  const f = await fixture();
  f.faux.setResponses(
    Array.from({ length: 3 }, () => (context) => {
      expect(
        context.messages.filter((message) => message.role === "user"),
      ).toHaveLength(1);
      return fauxAssistantMessage("Received");
    }),
  );
  await f.receive(update(1, "First user"));
  await f.receive(update(2, "Second user", 2));
  await f.receive(update(3, "Another topic", 1, false, false, 7));
  await f.flush();
  await f.close();
  await f.open();
  f.faux.setResponses([
    (context) => {
      expect(
        context.messages
          .filter((message) => message.role === "user")
          .map((message) => message.content),
      ).toEqual([[inputText(1, "First user")], [inputText(4, "Continue")]]);
      return fauxAssistantMessage("Continue replying");
    },
  ]);
  await f.receive(update(1, "First user"));
  await f.receive(update(4, "Continue"));
  await f.flush();
  expect(f.faux.state.callCount).toBe(4);
  expect(f.sent).toHaveLength(4);
});

test("Resets context once for duplicate new commands", async () => {
  const f = await fixture();
  f.faux.setResponses([fauxAssistantMessage("Old reply")]);
  await f.receive(update(1, "Old message"));
  await f.flush();
  await f.receive(update(2, "/new"));
  await f.flush();
  f.faux.setResponses([
    (context) => {
      expect(
        context.messages
          .filter((message) => message.role === "user")
          .map((message) => message.content),
      ).toEqual([[inputText(3, "New message")]]);
      return fauxAssistantMessage("New reply");
    },
    (context) => {
      expect(
        context.messages
          .filter((message) => message.role === "user")
          .map((message) => message.content),
      ).toEqual([[inputText(3, "New message")], [inputText(4, "Continue")]]);
      return fauxAssistantMessage("Continue replying");
    },
  ]);
  await f.receive(update(3, "New message"));
  await f.flush();
  await f.close();
  await f.open();
  await f.receive(update(2, "/new"));
  await f.receive(update(4, "Continue"));
  await f.flush();
  expect(
    f.sent.filter((message) => message.text === "Context reset."),
  ).toHaveLength(1);
});

test("Reports active work and stops both running and queued input", async () => {
  const f = await fixture();
  const started = Promise.withResolvers<void>();
  const status = Promise.withResolvers<void>();
  f.onSent((message) => {
    if (message.text.includes("Status: Working")) status.resolve();
  });
  f.faux.setResponses([
    async (_context, options) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else
          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
      });
      return fauxAssistantMessage("This must not be sent");
    },
  ]);
  await f.receive(update(1, "Slow request"));
  await started.promise;
  await f.receive(update(2, "Queued request"));
  await f.prepare();
  await f.receive(update(3, "/status"));
  await status.promise;
  expect(f.sent.at(-1)?.text).toContain("Queued: 1 item");
  await f.receive(update(4, "/stop"));
  await f.flush();
  expect(f.sent.at(-1)?.text).toBe("Stopped.");
  expect(
    f.sent.some((message) => message.text === "This must not be sent"),
  ).toBe(false);
  expect(f.faux.state.callCount).toBe(1);
});

test("Keeps reply delivery in the run before starting queued input", async () => {
  const f = await fixture();
  const blocked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.beforeSend(async (message) => {
    if (message.text === "First reply") {
      blocked.resolve();
      await release.promise;
    }
  });
  f.faux.setResponses([
    fauxAssistantMessage("First reply"),
    fauxAssistantMessage("Second reply"),
  ]);
  await f.receive(update(1, "First input"));
  await blocked.promise;
  let idle = false;
  const waiting = f.harness.waitForIdle(BACKGROUND_CONTEXT).then(() => {
    idle = true;
  });
  try {
    await f.receive(update(1, "First input"));
    await f.receive(update(2, "Second input"));
    await f.prepare();
    await f.receive(update(3, "/status"));
    expect(f.sent.at(-1)?.text).toContain("Status: Working");
    expect(f.sent.at(-1)?.text).toContain("Queued: 1 item");
    expect(f.faux.state.callCount).toBe(1);
    expect(idle).toBe(false);
    const inspection = await f.harness.inspect(BACKGROUND_CONTEXT);
    const generation = inspection.tasks.find(
      ({ record }) => record.kind === "pi.generation",
    );
    expect(
      inspection.tasks.some(
        ({ record }) =>
          record.kind === "amadeus.telegram.deliver" &&
          record.owner !== undefined &&
          record.owner === generation?.record.id &&
          !record.background,
      ),
    ).toBe(true);
  } finally {
    release.resolve();
    await waiting;
  }
  await f.flush();
  expect(f.sent.slice(1).map((message) => message.text)).toEqual([
    "First reply",
    "Second reply",
  ]);
  expect(f.faux.state.callCount).toBe(2);
});

test("Cancels run-owned delivery and withdraws queued input on stop", async () => {
  const f = await fixture();
  const blocked = Promise.withResolvers<void>();
  f.beforeSend(async (message, signal) => {
    if (message.text !== "Reply that must not be sent") return;
    blocked.resolve();
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  f.faux.setResponses([fauxAssistantMessage("Reply that must not be sent")]);
  await f.receive(update(1, "Sending"));
  await blocked.promise;
  await f.receive(update(2, "Queued input"));
  await f.receive(update(3, "/stop"));
  await f.flush();
  expect(f.sent.map((message) => message.text)).toEqual(["Stopped."]);
  expect(f.faux.state.callCount).toBe(1);
  f.beforeSend();
  f.faux.setResponses([fauxAssistantMessage("Continues after stop")]);
  await f.receive(update(4, "Continue"));
  await f.flush();
  expect(f.sent.at(-1)?.text).toBe("Continues after stop");
});

for (const markdown of [false, true]) {
  test(`Resumes unsent reply chunks without splitting characters (${markdown ? "Markdown" : "plain text"})`, async () => {
    const f = await fixture();
    const blocked = Promise.withResolvers<void>();
    let attempts = 0;
    f.beforeSend(async (_message, signal) => {
      if (++attempts !== 2) return;
      blocked.resolve();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const first = "一".repeat(4095);
    const second = String.fromCodePoint(0x1f600) + "结束";
    f.faux.setResponses([
      fauxAssistantMessage(markdown ? `**${first + second}**` : first + second),
    ]);
    await f.receive(update(1, "Long reply"));
    await blocked.promise;
    await f.close();
    expect(f.sent.map((message) => message.text)).toEqual([first]);
    f.beforeSend();
    await f.open();
    await f.flush();
    expect(f.sent.map((message) => message.text)).toEqual([first, second]);
    expect(f.faux.state.callCount).toBe(1);
    if (markdown)
      for (const message of f.sent)
        expect(message.entities).toEqual([
          { type: "bold", offset: 0, length: message.text.length },
        ]);
  });
}

test("Persists original model errors without duplicate failure deliveries", async () => {
  const f = await fixture();
  const error =
    '400: {"error":{"message":"invalid model","type":"invalid_request_error"}}\nOriginal error details';
  const blocked = Promise.withResolvers<void>();
  f.beforeSend(async (_message, signal) => {
    blocked.resolve();
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  f.faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: error }),
  ]);
  await f.receive(update(1, "Trigger a model error"));
  await blocked.promise;
  await f.receive(update(1, "Trigger a model error"));
  await f.close();
  f.beforeSend();
  await f.open();
  await f.receive(update(1, "Trigger a model error"));
  await f.flush();
  expect(f.sent.map((message) => message.text)).toEqual([error]);
  expect(f.faux.state.callCount).toBe(1);
});

test("Preserves a fixed input window and deduplicates receipts across restart", async () => {
  const f = await fixture(700);
  f.faux.setResponses([
    (context) => {
      const users = context.messages.filter(
        (message) => message.role === "user",
      );
      expect(users.map((message) => message.content)).toEqual([
        [
          inputText(1, "First message"),
          inputText(2, "Second message"),
          inputText(3, "Third message"),
        ],
      ]);
      return fauxAssistantMessage("Batched reply");
    },
  ]);
  await f.receive(update(1, "First message"));
  const tasks = (await f.harness.inspect(BACKGROUND_CONTEXT)).tasks.filter(
    ({ record }) => record.kind === "amadeus.telegram.collect",
  );
  expect(tasks).toHaveLength(1);
  for (const { record } of tasks) {
    const before = await f.harness.snapshot(
      Ingress,
      record.conversationId,
      BACKGROUND_CONTEXT,
    );
    await Bun.sleep(20);
    await f.receive(update(2, "Second message"));
    await f.receive(update(1, "First message"));
    await f.receive(update(4, "/status"));
    expect(f.sent.at(-1)?.text).toContain("Collecting: 2 messages");
    expect(f.faux.state.callCount).toBe(0);
    await f.close();
    await f.open();
    await f.receive(update(2, "Second message"));
    await f.receive(update(3, "Third message"));
    const after = await f.harness.snapshot(
      Ingress,
      record.conversationId,
      BACKGROUND_CONTEXT,
    );
    expect(after?.collecting?.until).toBe(before?.collecting?.until);
    const batch = await f.harness.snapshot(
      BatchMessages,
      record.id,
      BACKGROUND_CONTEXT,
    );
    expect(batch?.receipts).toHaveLength(3);
    await f.flush();
    const entries = await f.harness.commit(
      (tx) =>
        tx.scanEntries(
          { conversationId: record.conversationId, order: "ascending" },
          50,
        ),
      BACKGROUND_CONTEXT,
    );
    const all = entries.items.filter(Received.is);
    expect(all).toHaveLength(4);
    const received = all.filter(
      ({ data }) => "mode" in data && data.mode === "content",
    );
    expect(received).toHaveLength(3);
    expect(received.map(({ data }) => data.text)).toEqual([
      inputText(1, "First message").text,
      inputText(2, "Second message").text,
      inputText(3, "Third message").text,
    ]);
    for (const { data } of received) {
      expect(Object.keys(data).sort()).toEqual([
        "files",
        "metadata",
        "mode",
        "text",
      ]);
    }
    expect(entries.items.filter(TelegramInput.is)).toHaveLength(1);
  }
  expect(f.faux.state.callCount).toBe(1);
  expect(f.sent.at(-1)?.text).toBe("Batched reply");
});

test("Batches photos, captions, and text without exposing download URLs", async () => {
  const f = await fixture(700);
  f.faux.setResponses([
    (context) => {
      const users = context.messages.filter(
        (message) => message.role === "user",
      );
      expect(users).toHaveLength(1);
      const content = users[0]?.content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content.map((part) => part.type)).toEqual([
          "text",
          "image",
          "text",
          "text",
          "image",
        ]);
        expect(content.filter((part) => part.type === "text")).toEqual([
          attachmentText(1, "Image caption"),
          inputText(2, "Additional text"),
          attachmentText(3),
        ]);
        expect(
          content
            .filter((part) => part.type === "image")
            .every(
              (part) => part.mimeType === "image/png" && part.data.length > 0,
            ),
        ).toBe(true);
      }
      expect(JSON.stringify(context.messages)).not.toContain("123:TEST");
      expect(JSON.stringify(context.messages)).not.toContain("/file/bot");
      return fauxAssistantMessage("Received two images and text");
    },
  ]);
  await f.receive(photoUpdate(1, "Image caption"));
  await f.receive(update(2, "Additional text"));
  await f.receive(photoUpdate(3));
  await f.flush();
  expect(f.downloads).toEqual(["photo-1", "photo-3"]);
  expect(f.faux.state.callCount).toBe(1);
  expect(f.sent.map((message) => message.text)).toEqual([
    "Received two images and text",
  ]);
});

test.each(["answer", "failure"])(
  "Suppresses a stale %s when input arrives before the send checkpoint",
  async (kind) => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    // Registry erases task generics; this name belongs only to DeliveryTask.
    const delivery = f.registry
      .snapshot()
      .task("amadeus.telegram.deliver") as DeliveryTask;
    const prepare = delivery.definition.phases.prepare;
    let pause = true;
    const blocked = spyOn(
      delivery.definition.phases,
      "prepare",
    ).mockImplementation(async (task, runtime, ctx) => {
      if (!pause || task.input.kind !== kind)
        return prepare(task, runtime, ctx);
      pause = false;
      const commit = runtime.commit.bind(runtime);
      const checkpoint = spyOn(runtime, "commit").mockImplementationOnce(
        async (change, commitContext, options) => {
          entered.resolve();
          await release.promise;
          return commit(change, commitContext, options);
        },
      );
      try {
        return await prepare(task, runtime, ctx);
      } finally {
        checkpoint.mockRestore();
      }
    });
    f.faux.setResponses([
      kind === "answer"
        ? fauxAssistantMessage("Stale answer")
        : fauxAssistantMessage("", {
            stopReason: "error",
            errorMessage: "Stale error",
          }),
      fauxAssistantMessage("Current answer"),
    ]);
    try {
      await f.receive(update(1, "Original input"));
      await entered.promise;
      expect(f.sent).toHaveLength(0);
      await f.receive(update(2, "New input"));
      release.resolve();
      await f.flush();
      expect(f.sent.map(({ text }) => text)).toEqual(["Current answer"]);
      expect(f.faux.state.callCount).toBe(2);
    } finally {
      release.resolve();
      blocked.mockRestore();
      await f.flush();
    }
  },
);

for (const stopReason of ["stop", "error"] satisfies ("stop" | "error")[]) {
  test(`Suppresses stale ${stopReason === "stop" ? "answers" : "errors"} without interrupting the running model`, async () => {
    const f = await fixture(700);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    f.faux.setResponses([
      async (_context, options) => {
        signal = options?.signal;
        started.resolve();
        await release.promise;
        return fauxAssistantMessage("Old answer", {
          stopReason,
          ...(stopReason === "error"
            ? { errorMessage: "Old request error" }
            : {}),
        });
      },
      (context) => {
        expect(
          context.messages
            .filter((message) => message.role === "user")
            .map((message) => message.content),
        ).toEqual([
          [inputText(1, "Original question")],
          [inputText(2, "First addition"), inputText(3, "Second addition")],
        ]);
        return fauxAssistantMessage("Reply using all inputs");
      },
    ]);
    await f.receive(update(1, "Original question"));
    await started.promise;
    const generations = (
      await f.harness.inspect(BACKGROUND_CONTEXT)
    ).tasks.filter(({ record }) => record.kind === "pi.generation");
    try {
      await f.receive(update(2, "First addition"));
      await f.receive(update(3, "Second addition"));
      expect(signal?.aborted).toBe(false);
      release.resolve();
      await Promise.all(
        generations.map(({ record }) =>
          f.harness.waitForTask(record.id, BACKGROUND_CONTEXT),
        ),
      );
      await f.flush();
      expect(f.sent.map((message) => message.text)).toEqual([
        "Reply using all inputs",
      ]);
      expect(f.faux.state.callCount).toBe(2);
    } finally {
      release.resolve();
    }
  });
}

test("Preserves batch order across restart when an earlier image is slow", async () => {
  const f = await fixture();
  const downloading = Promise.withResolvers<void>();
  const releasePhoto = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const releaseModel = Promise.withResolvers<void>();
  f.beforePhoto(async () => {
    downloading.resolve();
    await releasePhoto.promise;
  });
  f.faux.setResponses([
    async () => {
      started.resolve();
      await releaseModel.promise;
      return fauxAssistantMessage("Old image reply");
    },
    (context) => {
      const users = context.messages.filter(
        (message) => message.role === "user",
      );
      expect(users).toHaveLength(2);
      expect(users[0]?.content).toEqual([
        attachmentText(1),
        expect.objectContaining({ type: "image" }),
      ]);
      expect(users[1]?.content).toEqual([inputText(2, "Explain this image")]);
      return fauxAssistantMessage("Complete image reply");
    },
  ]);
  try {
    await f.receive(photoUpdate(1));
    await downloading.promise;
    await f.receive(update(2, "Explain this image"));
    await f.receive(update(3, "/status"));
    expect(f.faux.state.callCount).toBe(0);
    await f.close();
    f.beforePhoto();
    await f.open();
    releasePhoto.resolve();
    await started.promise;
    await f.prepare();
    releaseModel.resolve();
    await f.flush();
    expect(f.sent.slice(1).map((message) => message.text)).toEqual([
      "Complete image reply",
    ]);
  } finally {
    releasePhoto.resolve();
    releaseModel.resolve();
  }
});

test("Applies steering at tool boundaries and delivers only the latest answer", async () => {
  const f = await fixture();
  const typing = spyOn(f.api, "sendChatAction");
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let executions = 0;
  const work = defineTool({
    name: "work",
    description: "work",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async (_args, _api, context) => {
      executions++;
      started.resolve();
      await release.promise;
      expect(context.abortSignal?.aborted).toBe(false);
      return { output: [{ type: "text", text: "Tool completed" }] };
    },
  });
  f.registry.install(defineExtension({ name: "test.work", tools: [work] }));
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("work", {}), { stopReason: "toolUse" }),
    (context) => {
      expect(
        context.messages
          .filter((message) => message.role === "user")
          .map((message) => message.content),
      ).toEqual([
        [inputText(1, "Run the tool")],
        [inputText(2, "First addition")],
        [inputText(3, "Second addition")],
      ]);
      return fauxAssistantMessage("Tool and additional inputs completed");
    },
  ]);
  try {
    await f.receive(update(1, "Run the tool"));
    await started.promise;
    const signal = typing.mock.calls[0]?.[3];
    expect(signal?.aborted).toBe(false);
    await f.receive(update(2, "First addition"));
    await f.receive(update(3, "Second addition"));
    await f.prepare();
    expect(signal?.aborted).toBe(false);
    release.resolve();
    await f.flush();
    expect(signal?.aborted).toBe(true);
    expect(executions).toBe(1);
    expect(f.sent.map((message) => message.text)).toEqual([
      "Tool and additional inputs completed",
    ]);
    expect(f.notifications).toHaveLength(1);
    expect(f.deletions.flatMap(({ message_ids }) => message_ids)).toEqual(
      f.notifications.map(({ message_id }) => message_id),
    );
  } finally {
    release.resolve();
    typing.mockRestore();
  }
});

test("Prevents cancelled input from returning after stop, reset, or restart", async () => {
  const f = await fixture(700);
  await f.receive(update(1, "Cancelled input"));
  await f.receive(update(2, "/stop"));
  await f.close();
  await f.open();
  await f.receive(update(1, "Cancelled input"));
  await f.receive(update(2, "/stop"));
  await f.flush();
  expect(f.faux.state.callCount).toBe(0);
  await f.receive(update(3, "Input before reset"));
  await f.receive(update(4, "/new"));
  await f.close();
  await f.open();
  await f.receive(update(3, "Input before reset"));
  f.faux.setResponses([
    (context) => {
      expect(
        context.messages
          .filter((message) => message.role === "user")
          .map((message) => message.content),
      ).toEqual([[inputText(5, "Accepted input")]]);
      return fauxAssistantMessage("Accepted reply");
    },
  ]);
  await f.receive(update(5, "Accepted input"));
  await f.flush();
  expect(f.sent.map((message) => message.text)).toEqual([
    "Stopped.",
    "Context reset.",
    "Accepted reply",
  ]);
  expect(f.faux.state.callCount).toBe(1);
});

test("Accepts stop commands while downloading and cancels the download", async () => {
  const f = await fixture();
  const downloading = Promise.withResolvers<void>();
  f.beforePhoto(async (signal) => {
    downloading.resolve();
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  await f.receive(photoUpdate(1));
  await downloading.promise;
  await f.receive(update(2, "/stop"));
  await f.flush();
  expect(f.faux.state.callCount).toBe(0);
  f.beforePhoto();
  f.faux.setResponses([fauxAssistantMessage("New image reply")]);
  await f.receive(photoUpdate(3));
  await f.flush();
  expect(f.sent.map((message) => message.text)).toEqual([
    "Stopped.",
    "New image reply",
  ]);
});

test("Leaves submission errors to the framework instead of treating them as attachment failures", async () => {
  const f = await fixture();
  const error = { message: "commit failure", detail: { stage: "input" } };
  // Registry erases task generics; this name belongs only to DeliveryTask.
  const delivery = f.registry
    .snapshot()
    .task("amadeus.telegram.deliver") as DeliveryTask;
  const initial = spyOn(delivery.definition, "initial").mockImplementationOnce(
    () => {
      throw error;
    },
  );
  const report = spyOn(console, "error").mockImplementation(() => {});
  try {
    await f.receive(update(1, "Submission failed"));
    await f.flush();
    const tasks = await f.harness.commit(
      (tx) => tx.scanTasks({ kind: "amadeus.telegram.collect" }, 1),
      BACKGROUND_CONTEXT,
    );
    expect(initial).toHaveBeenCalledTimes(1);
    expect(tasks.items[0]?.state).toMatchObject({
      status: "terminal",
      outcome: { status: "faulted" },
    });
    expect(report).toHaveBeenCalledWith(error);
    expect(f.sent).toHaveLength(0);
    expect(f.faux.state.callCount).toBe(0);
  } finally {
    initial.mockRestore();
    report.mockRestore();
  }
});

test("Reports original attachment errors without blocking later batches", async () => {
  const f = await fixture();
  const error = '502: {"error":"upstream file unavailable"}';
  f.beforePhoto(async () => new Response(error, { status: 502 }));
  const report = spyOn(console, "error").mockImplementation(() => {});
  try {
    await f.receive(photoUpdate(1));
    await f.flush();
    expect(f.sent.map((message) => message.text)).toEqual([error]);
    expect(f.faux.state.callCount).toBe(0);
    expect(report).toHaveBeenCalledWith(error);
  } finally {
    report.mockRestore();
  }
  f.faux.setResponses([fauxAssistantMessage("Continue replying")]);
  await f.receive(update(2, "Continue"));
  await f.flush();
  expect(f.sent.at(-1)?.text).toBe("Continue replying");
});

test("Persists full current-message metadata and deduplicates after restart", async () => {
  const f = await fixture(700);
  const bodies = [
    {
      contact: {
        phone_number: "+8612345",
        first_name: "Contact",
        user_id: 42,
        vcard: "BEGIN:VCARD",
      },
    },
    { location: { latitude: 31.2, longitude: 121.5, horizontal_accuracy: 10 } },
    { dice: { emoji: String.fromCodePoint(0x1f3b2), value: 3 } },
    {
      poll: {
        id: "poll",
        question: "Choose?",
        options: [{ text: "A", voter_count: 0, persistent_id: "option" }],
        total_voter_count: 0,
        is_closed: false,
        is_anonymous: true,
        type: "regular",
        allows_multiple_answers: false,
        allows_revoting: false,
        members_only: false,
      },
    },
  ] satisfies Partial<Message>[];
  f.faux.setResponses([
    (context) => {
      const users = context.messages.filter(
        (message) => message.role === "user",
      );
      expect(users).toHaveLength(1);
      const content = users[0]?.content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content).toHaveLength(bodies.length);
        for (const [index, body] of bodies.entries())
          expect(content[index]).toMatchObject({
            type: "text",
            text: expect.stringContaining(JSON.stringify(body)),
          });
      }
      return fauxAssistantMessage("Metadata received");
    },
  ]);
  for (const [index, body] of bodies.entries())
    await f.receive(messageUpdate(index + 1, body));
  await f.flush();
  await f.close();
  await f.open();
  await f.receive(messageUpdate(1, bodies[0] ?? {}));
  const received = (await f.entries()).filter(Received.is);
  expect(received).toHaveLength(bodies.length);
  for (const [index, record] of received.entries()) {
    expect(record.data).toMatchObject({
      mode: "content",
      metadata: { message_id: index + 1, ...bodies[index] },
    });
    expect(JSON.stringify(record.data)).not.toContain("update_id");
  }
  expect(f.faux.state.callCount).toBe(1);
  expect(f.sent.at(-1)?.text).toBe("Metadata received");
});

test("Records service messages without triggering or suppressing model input", async () => {
  const f = await fixture();
  const service = messageUpdate(1, {
    write_access_allowed: { from_request: true },
  });
  await f.receive(service);
  await f.receive(service);
  await f.receive(
    messageUpdate(2, {
      pinned_message: {
        message_id: 10,
        date: 1,
        chat: { id: 1, type: "private", first_name: "User" },
        text: "Do not copy old messages",
      },
    }),
  );
  await f.receive(update(3, "/status"));
  await f.receive(update(3, "/status"));
  await f.flush();
  expect(f.faux.state.callCount).toBe(0);
  expect(f.actions).toHaveLength(0);
  expect(f.sent).toHaveLength(2);
  const received = (await f.entries()).filter(Received.is);
  expect(received).toHaveLength(3);
  expect(
    received.map(({ data }) => ("mode" in data ? data.mode : "legacy")),
  ).toEqual(["service", "service", "command"]);
  expect(JSON.stringify(received)).not.toContain("Do not copy old messages");
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.faux.setResponses([
    async () => {
      started.resolve();
      await release.promise;
      return fauxAssistantMessage("Normal reply");
    },
  ]);
  try {
    await f.receive(update(4, "Question"));
    await started.promise;
    await f.receive(messageUpdate(5, { forum_topic_closed: {} }));
    release.resolve();
    await f.flush();
    expect(f.sent.at(-1)?.text).toBe("Normal reply");
    expect(f.faux.state.callCount).toBe(1);
  } finally {
    release.resolve();
  }
});

test("Persists attachments across reset and restart without downloading them again", async () => {
  const f = await fixture();
  const body = "Unique attachment body";
  f.beforePhoto(async () => new Response(body));
  let path = "";
  f.faux.setResponses([
    async (context) => {
      const uploads = (await f.entries()).filter(Uploaded.is);
      expect(uploads).toHaveLength(1);
      const file = uploads[0]?.data.files[0];
      expect(file).toBeDefined();
      if (!file) return fauxAssistantMessage("Missing attachment");
      path = file.path;
      expect(
        path.startsWith(join(f.config.stateDirectory, "uploads") + "/"),
      ).toBe(true);
      expect(path.startsWith(f.config.workspace + "/")).toBe(false);
      expect(file.name).toBe("../../原件.txt");
      expect(file.mimeType).toBe("text/plain");
      expect(JSON.stringify(context.messages)).toContain(path);
      expect(JSON.stringify(context.messages)).not.toContain(body);
      const input = context.messages.find(
        (message) => message.role === "user",
      )?.content;
      expect(Array.isArray(input)).toBe(true);
      if (Array.isArray(input)) {
        const text = input.find((part) => part.type === "text")?.text ?? "";
        expect(text.split("\n\n<attachments>\n")[1]).toBe(
          `${JSON.stringify(uploads[0]?.data.files)}\n</attachments>`,
        );
      }
      return fauxAssistantMessage(fauxToolCall("read", { path }), {
        stopReason: "toolUse",
      });
    },
    (context) => {
      expect(JSON.stringify(context.messages)).toContain(body);
      return fauxAssistantMessage("Read through the tool");
    },
  ]);
  const incoming = messageUpdate(1, {
    document: {
      file_id: "document",
      file_unique_id: "unique",
      file_name: "../../原件.txt",
      mime_type: "text/plain",
      file_size: Buffer.byteLength(body),
    },
    caption: "Read the attachment",
  });
  await f.receive(incoming);
  await f.flush();
  expect(f.sent.at(-1)?.text).toBe("Read through the tool");
  expect(await Bun.file(path).text()).toBe(body);
  await f.receive(update(2, "/new"));
  await f.close();
  await f.open();
  await f.receive(incoming);
  await f.flush();
  expect(await Bun.file(path).text()).toBe(body);
  expect(f.downloads).toEqual(["document"]);
  expect((await f.entries()).filter(Uploaded.is)).toHaveLength(1);
  expect(f.faux.state.callCount).toBe(2);
});

for (const imageInput of [true, false]) {
  test(`Saves original images and ${imageInput ? "includes native images" : "passes file references to text-only models"}`, async () => {
    const f = await fixture(0, imageInput);
    f.faux.setResponses([
      (context) => {
        const content = context.messages.find(
          (message) => message.role === "user",
        )?.content;
        expect(Array.isArray(content)).toBe(true);
        if (Array.isArray(content))
          expect(content.map((part) => part.type)).toEqual(
            imageInput ? ["text", "image"] : ["text"],
          );
        return fauxAssistantMessage("Original received");
      },
    ]);
    await f.receive(photoUpdate(1));
    await f.flush();
    const uploads = (await f.entries()).filter(Uploaded.is);
    const file = uploads[0]?.data.files[0];
    expect(file?.mimeType).toBe("image/png");
    expect(file && (await Bun.file(file.path).exists())).toBe(true);
    expect(f.sent.at(-1)?.text).toBe("Original received");
  });
}

test("Shares one Photon processor between inbound images and read", async () => {
  const f = await fixture();
  const prepare = spyOn(f.images, "prepare");
  f.faux.setResponses([
    async () => {
      const files = (await f.entries())
        .filter(Uploaded.is)
        .flatMap(({ data }) => data.files);
      expect(files).toHaveLength(1);
      const file = files[0];
      if (!file) return fauxAssistantMessage("Missing attachment");
      return fauxAssistantMessage(fauxToolCall("read", { path: file.path }), {
        stopReason: "toolUse",
      });
    },
    fauxAssistantMessage("Image processing completed"),
  ]);
  try {
    await f.receive(photoUpdate(1));
    await f.flush();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(f.sent.at(-1)?.text).toBe("Image processing completed");
  } finally {
    prepare.mockRestore();
  }
});

test("Passes non-image media as file references and retains preview metadata", async () => {
  const f = await fixture(700);
  f.beforePhoto(async () => new Response("Original attachment"));
  f.faux.setResponses([
    (context) => {
      const content = context.messages.find(
        (message) => message.role === "user",
      )?.content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content))
        expect(content.map((part) => part.type)).toEqual([
          "text",
          "text",
          "text",
          "text",
        ]);
      return fauxAssistantMessage("Attachments received");
    },
  ]);
  await f.receive(
    messageUpdate(1, {
      voice: {
        file_id: "voice",
        file_unique_id: "voice",
        duration: 3,
        mime_type: "audio/ogg",
      },
    }),
  );
  await f.receive(
    messageUpdate(2, {
      video: {
        file_id: "video",
        file_unique_id: "video",
        width: 8,
        height: 8,
        duration: 3,
      },
    }),
  );
  await f.receive(
    messageUpdate(3, {
      sticker: {
        file_id: "sticker",
        file_unique_id: "sticker",
        type: "regular",
        width: 8,
        height: 8,
        is_animated: true,
        is_video: false,
      },
    }),
  );
  await f.receive(
    messageUpdate(4, {
      paid_media: {
        star_count: 1,
        paid_media: [{ type: "preview", width: 8, height: 8, duration: 3 }],
      },
    }),
  );
  await f.flush();
  expect(f.downloads).toEqual(["voice", "video", "sticker"]);
  expect((await f.entries()).filter(Uploaded.is)).toHaveLength(3);
  expect((await f.entries()).filter(Received.is)).toHaveLength(4);
  expect(f.sent.at(-1)?.text).toBe("Attachments received");
});

test("Reuses completed attachments when a partially prepared batch resumes", async () => {
  const f = await fixture(700);
  const downloading = Promise.withResolvers<void>();
  let requests = 0;
  f.beforePhoto(async (signal) => {
    if (++requests !== 2) return;
    downloading.resolve();
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  f.faux.setResponses([fauxAssistantMessage("Attachments restored")]);
  await f.receive(photoUpdate(1));
  await f.receive(photoUpdate(2));
  await downloading.promise;
  await f.close();
  expect(f.faux.state.callCount).toBe(0);
  f.beforePhoto();
  await f.open();
  await f.receive(photoUpdate(1));
  await f.flush();
  expect(f.downloads).toEqual(["photo-1", "photo-2", "photo-2"]);
  expect((await f.entries()).filter(Uploaded.is)).toHaveLength(2);
  expect(f.sent.at(-1)?.text).toBe("Attachments restored");
});

test("Resumes legacy queued photo receipts without migrating history", async () => {
  const f = await fixture();
  const root = await f.harness.root(BACKGROUND_CONTEXT, {
    agent: { model: f.config.agent.model },
  });
  // This registry name identifies BatchTask; lookups erase task generics.
  const batch = f.registry
    .snapshot()
    .task("amadeus.telegram.collect") as BatchTask;
  f.faux.setResponses([fauxAssistantMessage("Legacy receipt restored")]);
  await root.commit(async (tx) => {
    const id = await root.submit(tx, {
      type: "write",
      requestId: "legacy-receipt",
      entry: {
        kind: Received.kind,
        data: { text: "Old image", photo: "legacy-photo" },
      },
    });
    const until = Date.now() + 700;
    const task = await tx.createTask(
      batch,
      { chatId: 1, threadId: null, until, after: null },
      { ownership: { kind: "conversation" } },
    );
    (await tx.doc(BatchMessages, task)).receipts.push(id);
    const ingress = await tx.doc(Ingress, root.id);
    ingress.collecting = { id: task, until };
    ingress.tail = task;
    ingress.latest = id;
  }, BACKGROUND_CONTEXT);
  await f.close();
  await f.open();
  await f.flush();
  expect(f.downloads).toEqual(["legacy-photo"]);
  expect(f.sent.at(-1)?.text).toBe("Legacy receipt restored");
});

test("Edits one silent progress message and removes it after the reply", async () => {
  const f = await fixture();
  function call(name: string, args: Parameters<typeof fauxToolCall>[1]) {
    return fauxAssistantMessage(fauxToolCall(name, args), {
      stopReason: "toolUse",
    });
  }
  f.faux.setResponses([
    call("write", { path: "sample.txt", content: "before" }),
    async () => {
      await f.flushProgress();
      return call("read", { path: "sample.txt" });
    },
    async () => {
      await f.flushProgress();
      return call("edit", {
        path: "sample.txt",
        edits: [{ oldText: "before", newText: "after" }],
      });
    },
    async () => {
      await f.flushProgress();
      return call("bash", { command: "printf done" });
    },
    async () => {
      await f.flushProgress();
      return fauxAssistantMessage("Tool completed");
    },
  ]);
  await f.receive(update(1, "Process the file", 1, false, false, 7));
  await f.flush();
  expect(f.notifications).toHaveLength(1);
  expect(f.notifications[0]).toMatchObject({
    chat_id: 1,
    message_thread_id: 7,
    disable_notification: true,
    link_preview_options: { is_disabled: true },
    text: "\u270d\ufe0f Write: sample.txt",
  });
  expect(f.edits).toHaveLength(3);
  expect(f.edits.at(-1)?.text).toBe(
    "\u270d\ufe0f Write: sample.txt\n\u{1f4d6} Read: sample.txt\n\u{1f4dd} Edit: sample.txt\n\u{1f6e0}\ufe0f Bash: printf done",
  );
  expect(
    f.edits.every(
      ({ message_id }) => message_id === f.notifications[0]?.message_id,
    ),
  ).toBe(true);
  expect(f.deletions).toEqual([
    {
      chat_id: 1,
      message_ids: f.notifications.map(({ message_id }) => message_id),
    },
  ]);
  expect(f.events.slice(-2)).toEqual(["answer", "delete"]);
  expect(f.actions.length).toBeGreaterThan(1);
  const state = await f.harness.snapshot(TelegramState, BACKGROUND_CONTEXT);
  for (const id of Object.values(state?.chats ?? {}))
    expect(
      (await f.harness.snapshot(ProgressMessage, id, BACKGROUND_CONTEXT))
        ?.messageId,
    ).toBeNull();
});

test("Shows codemode source without expanding nested tool calls", async () => {
  const f = await fixture();
  const code =
    "await tools.write({ path: 'nested.txt', content: 'nested' });\ntext(await tools.read({ path: 'nested.txt' }));\ntext(await tools.bash({ command: 'printf nested' }));";
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("codemode", { code }), {
      stopReason: "toolUse",
    }),
    async (context) => {
      await f.flushProgress();
      expect(f.notifications).toHaveLength(1);
      expect(f.notifications[0]?.text).toBe(
        toolProgressLine("codemode", { code }),
      );
      expect(Array.from(f.notifications[0]?.text ?? "")).toHaveLength(60);
      expect(f.edits).toHaveLength(0);
      expect(JSON.stringify(context.messages)).not.toContain(
        "\u{1f4e6} Codemode",
      );
      return fauxAssistantMessage("Script completed");
    },
  ]);
  await f.receive(update(1, "Run the script"));
  await f.flush();
  expect(await Bun.file(join(f.config.workspace, "nested.txt")).text()).toBe(
    "nested",
  );
  expect(f.sent.at(-1)?.text).toBe("Script completed");
  expect(f.deletions).toHaveLength(1);
});

test("Caps displayed progress without limiting actual tool calls", async () => {
  const f = await fixture();
  f.registry.install(
    defineExtension({
      name: "test.noop",
      tools: [
        defineTool({
          name: "noop",
          description: "noop",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          execute: async () => ({ output: [] }),
        }),
      ],
    }),
  );
  f.faux.setResponses([
    ...Array.from({ length: 17 }, (_, index) =>
      fauxAssistantMessage(fauxToolCall("noop", { path: `file-${index}` }), {
        stopReason: "toolUse",
      }),
    ),
    async () => {
      await f.flushProgress();
      const lines = (
        f.edits.at(-1)?.text ??
        f.notifications[0]?.text ??
        ""
      ).split("\n");
      expect(lines).toEqual([
        "…",
        ...Array.from(
          { length: 15 },
          (_, index) => `\u{1f6e0}\ufe0f Noop: file-${index + 2}`,
        ),
      ]);
      return fauxAssistantMessage("All done");
    },
  ]);
  await f.receive(update(1, "Repeated calls"));
  await f.flush();
  expect(f.faux.state.callCount).toBe(18);
  expect(f.notifications).toHaveLength(1);
  expect(f.sent.at(-1)?.text).toBe("All done");
});

for (const command of ["stop", "new"]) {
  test(`Clears tool progress on /${command} without adding model input`, async () => {
    const f = await fixture();
    const started = Promise.withResolvers<void>();
    f.registry.install(
      defineExtension({
        name: "test.wait",
        tools: [
          defineTool({
            name: "wait",
            description: "wait",
            parameters: { type: "object", properties: {} },
            execute: async (_args, _api, context) => {
              started.resolve();
              await new Promise<void>((resolve) => {
                if (context.abortSignal?.aborted) resolve();
                else
                  context.abortSignal?.addEventListener(
                    "abort",
                    () => resolve(),
                    { once: true },
                  );
              });
              return { output: [] };
            },
          }),
        ],
      }),
    );
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
    ]);
    await f.receive(update(1, "Waiting for the tool"));
    await started.promise;
    await f.flushProgress();
    expect(f.notifications).toHaveLength(1);
    await f.receive(update(2, `/${command}`));
    await f.flush();
    expect(f.deletions).toHaveLength(1);
    expect(f.faux.state.callCount).toBe(1);
  });
}

test("Keeps progress requests from blocking tools and cleans late messages", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const answered = Promise.withResolvers<void>();
  f.beforeProgress(async (method) => {
    if (method === "sendMessage") {
      entered.resolve();
      await release.promise;
    }
  });
  f.onSent(() => answered.resolve());
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "printf done" }), {
      stopReason: "toolUse",
    }),
    async () => {
      await entered.promise;
      return fauxAssistantMessage("Reply does not wait for progress");
    },
  ]);
  try {
    await f.receive(update(1, "Run the tool"));
    await answered.promise;
    expect(f.sent.at(-1)?.text).toBe("Reply does not wait for progress");
    expect(f.notifications).toHaveLength(0);
    release.resolve();
    await f.flush();
    expect(f.notifications).toHaveLength(1);
    expect(f.deletions).toHaveLength(1);
  } finally {
    release.resolve();
  }
});

test("Preserves progress errors without changing tool results or replies", async () => {
  const f = await fixture();
  const report = spyOn(console, "error").mockImplementation(() => {});
  f.beforeProgress(async () =>
    Response.json(
      { ok: false, error_code: 400, description: "original progress error" },
      { status: 400 },
    ),
  );
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "printf done" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Normal answer"),
  ]);
  try {
    await f.receive(update(1, "Run the tool"));
    await f.flush();
    expect(f.sent.at(-1)?.text).toBe("Normal answer");
    expect(
      report.mock.calls.some(
        ([error]) =>
          error instanceof Error &&
          "description" in error &&
          error.description === "original progress error",
      ),
    ).toBe(true);
  } finally {
    report.mockRestore();
  }
});

test("Keeps progress until the final reply chunk is sent", async () => {
  const f = await fixture();
  const sending = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.beforeSend(async ({ text }) => {
    if (text === "尾") {
      sending.resolve();
      await release.promise;
    }
  });
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "printf done" }), {
      stopReason: "toolUse",
    }),
    async () => {
      await f.flushProgress();
      return fauxAssistantMessage("a".repeat(4096) + "尾");
    },
  ]);
  try {
    await f.receive(update(1, "Long reply"));
    await sending.promise;
    expect(f.notifications).toHaveLength(1);
    expect(f.deletions).toHaveLength(0);
    release.resolve();
    await f.flush();
    expect(f.sent).toHaveLength(2);
    expect(f.deletions).toHaveLength(1);
    expect(f.events.slice(-3)).toEqual(["answer", "answer", "delete"]);
  } finally {
    release.resolve();
  }
});

test("Removes stale progress references on restart without replaying tools", async () => {
  const f = await fixture();
  const started = Promise.withResolvers<void>();
  let executions = 0;
  f.registry.install(
    defineExtension({
      name: "test.restart",
      tools: [
        defineTool({
          name: "restart_wait",
          description: "wait",
          parameters: { type: "object", properties: {} },
          execute: async (_args, _api, context) => {
            executions++;
            started.resolve();
            await new Promise<void>((resolve) => {
              if (context.abortSignal?.aborted) resolve();
              else
                context.abortSignal?.addEventListener(
                  "abort",
                  () => resolve(),
                  { once: true },
                );
            });
            return { output: [] };
          },
        }),
      ],
    }),
  );
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("restart_wait", {}), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Restored answer"),
  ]);
  await f.receive(update(1, "Restart test"));
  await started.promise;
  await f.flushProgress();
  expect(f.notifications).toHaveLength(1);
  expect(f.deletions).toHaveLength(0);
  await f.close();
  await f.open();
  await f.flush();
  expect(executions).toBe(1);
  expect(f.notifications).toHaveLength(1);
  expect(f.deletions).toHaveLength(1);
  expect(f.sent.at(-1)?.text).toBe("Restored answer");
  await f.close();
  await f.open();
  await f.flush();
  expect(f.deletions).toHaveLength(1);
});

test("Does not send Telegram progress for unrelated conversations", async () => {
  const f = await fixture();
  const root = await f.harness.root(BACKGROUND_CONTEXT, {
    agent: { model: f.config.agent.model },
  });
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "printf other" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Reply for another channel"),
  ]);
  await (
    await root.submit(
      { type: "input", content: "Another channel" },
      BACKGROUND_CONTEXT,
    )
  ).wait(BACKGROUND_CONTEXT);
  await f.flush();
  expect(f.notifications).toHaveLength(0);
  expect(f.sent).toHaveLength(0);
});

test("Cleans progress after model failure and preserves the original error", async () => {
  const f = await fixture();
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "printf done" }), {
      stopReason: "toolUse",
    }),
    async () => {
      await f.flushProgress();
      return fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "original model failure",
      });
    },
  ]);
  await f.receive(update(1, "Failure test"));
  await f.flush();
  expect(f.notifications).toHaveLength(1);
  expect(f.deletions).toHaveLength(1);
  expect(f.sent.at(-1)?.text).toBe("original model failure");
});

test("Cancels and joins pending progress requests on close", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const report = spyOn(console, "error").mockImplementation(() => {});
  f.beforeProgress(async (method, signal) => {
    if (method !== "sendMessage") return;
    entered.resolve();
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    cancelled.resolve();
  });
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "printf done" }), {
      stopReason: "toolUse",
    }),
    async (_request, options) => {
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else
          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
      });
      return fauxAssistantMessage("Cancel");
    },
  ]);
  try {
    await f.receive(update(1, "Close test"));
    await entered.promise;
    await f.close();
    await cancelled.promise;
    expect(f.notifications).toHaveLength(0);
    expect(report).not.toHaveBeenCalled();
  } finally {
    report.mockRestore();
  }
});

test("Scopes the Telegram prompt to routed conversations", async () => {
  const f = await fixture();
  f.faux.setResponses([
    (request) => {
      const prompt = getCurrentSystemPrompt(request.messages);
      expect(prompt).toContain(
        "<platform>\n<telegram>\nEach user message starts with [Telegram #<id> <sender> <time>].",
      );
      expect(prompt).toContain("Times are UTC");
      expect(prompt).toContain("[Replying to: ...] and [Forwarded from ...]");
      expect(prompt).toContain("[Telegram content] describes non-text content");
      expect(prompt).toContain("<attachments> lists saved files");
      expect(prompt).toContain("native image blocks");
      expect(prompt).toContain("Reply in the user's language.");
      expect(prompt).toContain("Use ordinary Markdown, not MarkdownV2");
      expect(prompt).toContain("<system>");
      expect(prompt).toContain("session_read");
      expect(prompt).toContain("session_search");
      expect(prompt).toContain("</telegram>\n<ipc>\n");
      expect(prompt).toContain('bun run "$AMADEUS_NOTIFY_CLI"');
      expect(prompt).toContain("Reply to the user yourself");
      expect(prompt).toContain("<scheduled>");
      expect(prompt.match(/<platform>/g)).toHaveLength(1);
      expect(prompt.match(/<\/platform>/g)).toHaveLength(1);
      for (const absent of [
        "<local>",
        "<schedule>",
        "<notifications>",
        "<scheduled_tasks>",
      ])
        expect(prompt).not.toContain(absent);
      return fauxAssistantMessage("**Platform prompt loaded**");
    },
  ]);
  await f.receive(update(1, "Check platform behavior"));
  await f.flush();
  expect(f.sent.map(({ text }) => text)).toEqual(["Platform prompt loaded"]);
  const root = await f.harness.root(BACKGROUND_CONTEXT, {
    agent: f.agent.configuration,
  });
  f.faux.setResponses([
    (request) => {
      const prompt = getCurrentSystemPrompt(request.messages);
      expect(prompt).toContain("<system>");
      expect(prompt).toContain("<platform>\n<ipc>");
      expect(prompt).not.toContain("<telegram>");
      expect(prompt).not.toContain("Each user message starts with [Telegram");
      return fauxAssistantMessage(
        "Ordinary conversations omit Telegram instructions",
      );
    },
  ]);
  expect(
    (
      await (
        await root.submit(
          { type: "input", content: "Ordinary conversation" },
          BACKGROUND_CONTEXT,
        )
      ).wait(BACKGROUND_CONTEXT)
    ).status,
  ).toBe("done");
  await f.flush();
  expect(f.sent.map(({ text }) => text)).toEqual(["Platform prompt loaded"]);
});

test.each(["finish", "stop"])(
  "Waits for draft teardown before send_file proceeds: %s",
  async (action) => {
    using resources = new DisposableStack();
    const opened =
      Promise.withResolvers<
        Awaited<ReturnType<typeof replyStreaming.openReplyStream>>
      >();
    const open = replyStreaming.openReplyStream;
    const opening = spyOn(replyStreaming, "openReplyStream").mockImplementation(
      async (...args) => {
        const stream = await open(...args);
        opened.resolve(stream);
        return stream;
      },
    );
    resources.defer(() => opening.mockRestore());
    const f = await fixture(0, true, true, 10);
    const stream = await opened.promise;
    const entered = Promise.withResolvers<void>();
    const lateDraft = Promise.withResolvers<true>();
    const cancelled = Promise.withResolvers<void>();
    const order: string[] = [];
    const stop = stream.stop.bind(stream);
    const stopping = spyOn(stream, "stop").mockImplementation(
      async (conversation) => {
        entered.resolve();
        await stop(conversation);
        order.push("draft stopped");
      },
    );
    resources.defer(() => stopping.mockRestore());
    const draft = spyOn(f.api, "sendMessageDraft").mockImplementation(
      () => lateDraft.promise,
    );
    resources.defer(() => draft.mockRestore());
    const observation = f.harness.observeCommits({
      advance(publication) {
        if (
          publication.changes.some(
            (change) =>
              change.type === "task" &&
              change.value.kind === ToolTask.definition.name &&
              change.value.abortRequested,
          )
        )
          cancelled.resolve();
      },
      end() {},
    });
    resources.defer(() => observation.detach());
    f.beforeUpload(async () => {
      order.push("upload");
    });
    await Bun.write(join(f.config.workspace, "file.txt"), "original bytes");
    f.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxText("Preparing the file.".repeat(2)),
          fauxToolCall("send_file", { path: "file.txt" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("File sent"),
    ]);
    let command: ReturnType<typeof f.receive> | undefined;
    try {
      await f.receive(update(1, "Send a file"));
      await entered.promise;
      expect(draft).toHaveBeenCalled();
      expect(order).toEqual([]);
      expect(f.uploadAttempts).toHaveLength(0);
      if (action === "stop") {
        command = f.receive(update(2, "/stop"));
        await cancelled.promise;
      }
      lateDraft.resolve(true);
      await command;
      await f.flush();
      if (action === "finish") {
        expect(f.uploads).toHaveLength(1);
        expect(order.indexOf("draft stopped")).toBeLessThan(
          order.indexOf("upload"),
        );
        expect(f.sent.at(-1)?.text).toBe("File sent");
      } else {
        expect(f.uploadAttempts).toHaveLength(0);
        expect(f.sent.map(({ text }) => text)).toEqual(["Stopped."]);
        expect(f.faux.state.callCount).toBe(1);
      }
    } finally {
      lateDraft.resolve(true);
      await command;
      await f.flush();
    }
  },
);

test("Sends original files and plain captions to the current chat and topic", async () => {
  const f = await fixture();
  const bytes = new Uint8Array([0, 255, 1, 128, 65, 10]);
  await Bun.write(join(f.config.workspace, "report.bin"), bytes);
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("send_file", {
        path: "report.bin",
        caption: "**Literal caption**",
      }),
      { stopReason: "toolUse" },
    ),
    (request) => {
      const result = request.messages.findLast(
        (message) => message.role === "toolResult",
      );
      expect(result?.toolName).toBe("send_file");
      expect(result?.isError).toBe(false);
      expect(contentText(result?.content ?? [])).toContain('"messageId":30000');
      return fauxAssistantMessage("File sent");
    },
  ]);
  await f.receive(update(1, "Send a file", 2, false, false, 7));
  await f.flush();
  expect(f.uploads).toEqual([
    {
      chat_id: 2,
      message_thread_id: 7,
      message_id: 30_000,
      kind: "document",
      name: "report.bin",
      caption: "**Literal caption**",
      bytes,
    },
  ]);
  expect(f.sent.map(({ text }) => text)).toEqual(["File sent"]);
  expect(f.events.indexOf("file")).toBeLessThan(f.events.indexOf("answer"));
  expect(
    f.notifications.some(({ text }) => text.includes("Send File: report.bin")),
  ).toBe(true);
});

test("Sends photos through codemode without exposing nested results", async () => {
  const f = await fixture();
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const path = join(f.config.stateDirectory, "picture.png");
  await Bun.write(path, bytes);
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("codemode", {
        code: `text(await tools.send_file({ path: ${JSON.stringify(path)}, kind: "photo", caption: "Photo caption" }));`,
      }),
      { stopReason: "toolUse" },
    ),
    (request) => {
      const results = request.messages.filter(
        (message) => message.role === "toolResult",
      );
      expect(results).toHaveLength(1);
      expect(results[0]?.toolName).toBe("codemode");
      expect(results[0]?.isError).toBe(false);
      expect(contentText(results[0]?.content ?? [])).toContain(
        '"messageId":30000',
      );
      return fauxAssistantMessage("Photo sent");
    },
  ]);
  await f.receive(update(1, "Send a photo"));
  await f.flush();
  expect(f.uploads).toHaveLength(1);
  expect(f.uploads[0]?.kind).toBe("photo");
  expect(f.uploads[0]?.bytes).toEqual(new Uint8Array(bytes));
  expect(f.uploads[0]?.caption).toBe("Photo caption");
  expect(
    f.notifications.every(({ text }) => !text.includes("Send File:")),
  ).toBe(true);
  expect(f.sent.map(({ text }) => text)).toEqual(["Photo sent"]);
});

test("Preserves send_file validation errors without uploading", async () => {
  const f = await fixture();
  await mkdir(join(f.config.workspace, "directory"));
  await Bun.write(join(f.config.workspace, "valid.txt"), "data");
  for (const [name, size] of [
    ["large-photo", 10 * 1024 * 1024 + 1],
    ["large-document", 50 * 1024 * 1024 + 1],
  ] as const) {
    const path = join(f.config.workspace, name);
    await Bun.write(path, "");
    await truncate(path, size);
  }
  const cases = [
    { path: "missing-file" },
    { path: "directory" },
    { path: "large-photo", kind: "photo" },
    { path: "large-document", kind: "document" },
    { path: "valid.txt", caption: "x".repeat(1025) },
    { path: "valid.txt", kind: "video" },
    { path: "valid.txt", chat_id: 999 },
  ];
  for (const [index, args] of cases.entries()) {
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("send_file", args), {
        stopReason: "toolUse",
      }),
      (request) => {
        const result = request.messages.findLast(
          (message) => message.role === "toolResult",
        );
        expect(result?.isError).toBe(true);
        if (index === 0)
          expect(contentText(result?.content ?? [])).toContain("ENOENT");
        return fauxAssistantMessage("Original tool error received");
      },
    ]);
    await f.receive(update(index + 1, "Validate file sending"));
    await f.flush();
  }
  expect(f.uploadAttempts).toHaveLength(0);
});

test("Rejects send_file from conversations without a Telegram route", async () => {
  const f = await fixture();
  await Bun.write(join(f.config.workspace, "file.txt"), "not sent");
  const root = await f.harness.root(BACKGROUND_CONTEXT, {
    agent: f.agent.configuration,
  });
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("send_file", { path: "file.txt" }), {
      stopReason: "toolUse",
    }),
    (request) => {
      const result = request.messages.findLast(
        (message) => message.role === "toolResult",
      );
      expect(result?.isError).toBe(true);
      return fauxAssistantMessage("Route rejected");
    },
  ]);
  expect(
    (
      await (
        await root.submit(
          { type: "input", content: "Send a file" },
          BACKGROUND_CONTEXT,
        )
      ).wait(BACKGROUND_CONTEXT)
    ).status,
  ).toBe("done");
  await f.flush();
  expect(f.uploadAttempts).toHaveLength(0);
  expect(f.sent).toHaveLength(0);
});

test("Rechecks send_file authorization at execution time", async () => {
  const f = await fixture();
  await Bun.write(join(f.config.workspace, "file.txt"), "data");
  f.registry.install(
    defineExtension({
      name: "test.restrict-file-sender",
      tools: [
        createSendFileTool(
          f.bot,
          new Set([2]),
          async () => {},
          () => {},
        ),
      ],
    }),
  );
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("send_file", { path: "file.txt" }), {
      stopReason: "toolUse",
    }),
    (request) => {
      const result = request.messages.findLast(
        (message) => message.role === "toolResult",
      );
      expect(result?.isError).toBe(true);
      return fauxAssistantMessage("File sending denied");
    },
  ]);
  await f.receive(update(1, "Check permissions"));
  await f.flush();
  expect(f.uploadAttempts).toHaveLength(0);
});

test("Preserves Telegram upload errors without retrying uncertain failures", async () => {
  const f = await fixture();
  await Bun.write(join(f.config.workspace, "file.txt"), "data");
  f.beforeUpload(async () =>
    Response.json(
      { ok: false, error_code: 500, description: "original upload failure" },
      { status: 500 },
    ),
  );
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("send_file", { path: "file.txt" }), {
      stopReason: "toolUse",
    }),
    (request) => {
      const result = request.messages.findLast(
        (message) => message.role === "toolResult",
      );
      expect(result?.isError).toBe(true);
      expect(contentText(result?.content ?? [])).toContain(
        "original upload failure",
      );
      return fauxAssistantMessage("Original upstream error received");
    },
  ]);
  await f.receive(update(1, "Fail the upload"));
  await f.flush();
  expect(f.uploadAttempts).toHaveLength(1);
  expect(f.uploads).toHaveLength(0);
});

test("Retries explicit Telegram rate limits from the beginning of the file", async () => {
  const f = await fixture();
  const bytes = new Uint8Array(1024 * 1024 + 7).fill(137);
  await Bun.write(join(f.config.workspace, "retry.bin"), bytes);
  f.beforeUpload(async () =>
    f.uploadAttempts.length === 1
      ? Response.json(
          {
            ok: false,
            error_code: 429,
            description: "Too Many Requests",
            parameters: { retry_after: 0 },
          },
          { status: 429 },
        )
      : undefined,
  );
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("send_file", { path: "retry.bin" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Sent after rate limiting"),
  ]);
  await f.receive(update(1, "Retry the upload"));
  await f.flush();
  expect(f.uploadAttempts).toHaveLength(2);
  expect(f.uploads).toHaveLength(1);
  for (const attempt of f.uploadAttempts) expect(attempt.bytes).toEqual(bytes);
});

for (const command of ["stop", "new"]) {
  test(`Cancels uploads on /${command} without resending`, async () => {
    const f = await fixture();
    await Bun.write(join(f.config.workspace, "file.txt"), "data");
    const entered = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    f.beforeUpload(async (_file, signal) => {
      entered.resolve();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      cancelled.resolve();
    });
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("send_file", { path: "file.txt" }), {
        stopReason: "toolUse",
      }),
    ]);
    await f.receive(update(1, "Cancel during upload"));
    await entered.promise;
    await f.receive(update(2, `/${command}`));
    await f.flush();
    await cancelled.promise;
    expect(f.uploadAttempts).toHaveLength(1);
    expect(f.uploads).toHaveLength(0);
    expect(f.faux.state.callCount).toBe(1);
    expect(f.sent.map(({ text }) => text)).toEqual([
      command === "stop" ? "Stopped." : "Context reset.",
    ]);
  });
}

test("Does not replay an uncertain upload after restart", async () => {
  const f = await fixture();
  await Bun.write(join(f.config.workspace, "file.txt"), "data");
  const entered = Promise.withResolvers<void>();
  f.beforeUpload(async (file, signal) => {
    f.uploads.push(file);
    entered.resolve();
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("send_file", { path: "file.txt" }), {
      stopReason: "toolUse",
    }),
    (request) => {
      const result = request.messages.findLast(
        (message) => message.role === "toolResult",
      );
      expect(result?.isError).toBe(true);
      expect(contentText(result?.content ?? [])).toContain("interrupted");
      return fauxAssistantMessage("Do not resend after interruption");
    },
  ]);
  await f.receive(update(1, "Restart during upload"));
  await entered.promise;
  await f.close();
  f.beforeUpload();
  await f.open();
  await f.flush();
  expect(f.uploadAttempts).toHaveLength(1);
  expect(f.uploads).toHaveLength(1);
  expect(f.sent.map(({ text }) => text)).toEqual([
    "Do not resend after interruption",
  ]);
});

test("Replays completed codemode upload receipts without sending again", async () => {
  const f = await fixture();
  await Bun.write(join(f.config.workspace, "file.txt"), "data");
  const entered = Promise.withResolvers<void>();
  f.registry.install(
    defineExtension({
      name: "test.pause-after-send",
      hooks: [
        hook(ToolTask, {
          async beforeTool(call, _api, context): Promise<undefined> {
            if (call.name !== "bash") return undefined;
            entered.resolve();
            await new Promise<void>((resolve) => {
              if (context.abortSignal?.aborted) resolve();
              else
                context.abortSignal?.addEventListener(
                  "abort",
                  () => resolve(),
                  { once: true },
                );
            });
            return undefined;
          },
        }),
      ],
    }),
  );
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("codemode", {
        code: 'text(await tools.send_file({path:"file.txt"})); text(await tools.bash({command:"printf resumed"}));',
      }),
      { stopReason: "toolUse" },
    ),
    (request) => {
      const result = request.messages.findLast(
        (message) => message.role === "toolResult",
      );
      expect(result?.isError).toBe(false);
      expect(contentText(result?.content ?? [])).toContain("resumed");
      return fauxAssistantMessage("Script resumed without another upload");
    },
  ]);
  await f.receive(update(1, "Resume the script"));
  await entered.promise;
  await f.close();
  await f.open();
  await f.flush();
  expect(f.uploads).toHaveLength(1);
  expect(f.uploadAttempts).toHaveLength(1);
  expect(f.sent.map(({ text }) => text)).toEqual([
    "Script resumed without another upload",
  ]);
});

test("Sends final Markdown entities while leaving errors as plain text", async () => {
  const f = await fixture();
  f.faux.setResponses([fauxAssistantMessage("**完成**，读取 `src/main.ts`。")]);
  await f.receive(update(1, "Formatted reply"));
  await f.flush();
  expect(f.sent.at(-1)?.text).toBe("完成，读取 src/main.ts。");
  expect(f.sent.at(-1)?.entities).toEqual([
    { type: "bold", offset: 0, length: 2 },
    { type: "code", offset: 6, length: 11 },
  ]);
  expect(f.drafts).toHaveLength(0);
  const error = "**original_error** _detail_";
  f.faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: error }),
  ]);
  await f.receive(update(2, "Return the original error"));
  await f.flush();
  expect(f.sent.at(-1)?.text).toBe(error);
  expect(f.sent.at(-1)?.entities).toEqual([]);
});

test("Streams draft text without exposing thinking or duplicating final history", async () => {
  const f = await fixture(0, true, true, 10);
  const text = "**" + "Streaming reply.".repeat(6) + "**";
  f.faux.setResponses([
    fauxAssistantMessage([fauxThinking("private reasoning"), fauxText(text)]),
  ]);
  await f.receive(update(1, "Stream a reply", 1, false, false, 7));
  await f.flush();
  expect(f.drafts.length).toBeGreaterThan(0);
  expect(
    f.drafts.some(
      ({ text }) => text.length < "Streaming reply.".repeat(6).length,
    ),
  ).toBe(true);
  expect(
    f.drafts.every(
      ({ chat_id, message_thread_id, entities }) =>
        chat_id === 1 &&
        message_thread_id === 7 &&
        entities?.some(({ type }) => type === "bold"),
    ),
  ).toBe(true);
  expect(new Set(f.drafts.map(({ draft_id }) => draft_id)).size).toBe(1);
  expect(JSON.stringify(f.drafts)).not.toContain("private reasoning");
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]?.text).toBe("Streaming reply.".repeat(6));
  expect(f.events.at(-1)).toBe("answer");
});

for (const command of ["stop", "new"]) {
  test(`Stops streaming drafts on /${command} and sends a plain command receipt`, async () => {
    const f = await fixture(0, true, true, 10);
    const entered = Promise.withResolvers<void>();
    f.beforeDraft(async () => {
      entered.resolve();
    });
    f.faux.setResponses([
      fauxAssistantMessage("**" + "Generating content.".repeat(8) + "**"),
    ]);
    await f.receive(update(1, "Cancel streaming"));
    await entered.promise;
    await f.flushProgress();
    expect(f.drafts.length).toBeGreaterThan(0);
    const count = f.drafts.length;
    await f.receive(update(2, `/${command}`));
    await f.flush();
    expect(f.drafts).toHaveLength(count);
    expect(f.sent.map(({ text }) => text)).toEqual([
      command === "stop" ? "Stopped." : "Context reset.",
    ]);
  });
}

test("Joins late draft requests before sending the final reply", async () => {
  const f = await fixture(0, true, true, 10);
  const entered = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  f.beforeDraft(async (_message, signal) => {
    entered.resolve();
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    cancelled.resolve();
  });
  const text = "Streaming.".repeat(7);
  f.faux.setResponses([fauxAssistantMessage(text)]);
  await f.receive(update(1, "Late draft"));
  await entered.promise;
  await f.flush();
  await cancelled.promise;
  expect(f.drafts).toHaveLength(0);
  expect(f.sent.map(({ text }) => text)).toEqual([text]);
  expect(f.events.at(-1)).toBe("answer");
});

test("Stops stale drafts when new input arrives without interrupting the model", async () => {
  const f = await fixture(700, true, true, 10);
  const entered = Promise.withResolvers<void>();
  f.beforeDraft(async () => {
    entered.resolve();
  });
  f.faux.setResponses([
    fauxAssistantMessage("Old draft.".repeat(8)),
    fauxAssistantMessage("**New answer**"),
  ]);
  await f.receive(update(1, "Old question"));
  await entered.promise;
  await f.flushProgress();
  const count = f.drafts.length;
  expect(count).toBeGreaterThan(0);
  await f.receive(update(2, "New question"));
  await f.flush();
  expect(
    f.drafts.slice(count).every(({ text }) => !text.startsWith("Old draft")),
  ).toBe(true);
  expect(f.sent.map(({ text }) => text)).toEqual(["New answer"]);
  expect(f.faux.state.callCount).toBe(2);
});

test("Preserves draft errors without blocking final delivery", async () => {
  const f = await fixture(0, true, true, 10);
  const report = spyOn(console, "error").mockImplementation(() => {});
  let attempts = 0;
  f.beforeDraft(async () => {
    attempts++;
    return Response.json(
      { ok: false, error_code: 400, description: "original draft failure" },
      { status: 400 },
    );
  });
  const text = "**" + "Streaming.".repeat(8) + "**";
  f.faux.setResponses([fauxAssistantMessage(text)]);
  try {
    await f.receive(update(1, "Draft API failure"));
    await f.flush();
    expect(attempts).toBe(1);
    expect(f.sent.at(-1)?.text).toBe("Streaming.".repeat(8));
    expect(
      report.mock.calls.some(
        ([error]) =>
          error instanceof Error &&
          "description" in error &&
          error.description === "original draft failure",
      ),
    ).toBe(true);
  } finally {
    report.mockRestore();
  }
});

test("Resumes generation after restart without replaying stale drafts", async () => {
  const f = await fixture(0, true, true, 10);
  const entered = Promise.withResolvers<void>();
  f.beforeDraft(async () => {
    entered.resolve();
  });
  f.faux.setResponses([
    fauxAssistantMessage("Content before restart.".repeat(8)),
    fauxAssistantMessage("**Restored answer**"),
  ]);
  await f.receive(update(1, "Restart streaming"));
  await entered.promise;
  await f.close();
  await f.open();
  await f.flush();
  expect(f.sent.map(({ text }) => text)).toEqual(["Restored answer"]);
  expect(f.faux.state.callCount).toBe(2);
  expect(f.events.at(-1)).toBe("answer");
});

for (const stage of ["routes", "registry"] as const) {
  test(`Releases UI subscriptions when Telegram setup fails at ${stage}`, async () => {
    const f = await fixture();
    const error = new RangeError("original startup failure");
    const releases: (() => void)[] = [];
    const originalSubscribe = f.harness.subscribeClose.bind(f.harness);
    const subscribe = spyOn(f.harness, "subscribeClose").mockImplementation(
      (listener) => {
        const release = mock(originalSubscribe(listener));
        releases.push(release);
        return release;
      },
    );
    const failure =
      stage === "routes"
        ? spyOn(f.harness, "observeDoc").mockRejectedValueOnce(error)
        : spyOn(f.registry, "install").mockImplementationOnce(() => {
            throw error;
          });
    try {
      await expect(
        configureTelegram(f.bot, f.agent, {
          ...telegramConfigSchema.parse(f.config.channels.telegram),
          streaming: true,
        }),
      ).rejects.toBe(error);
      expect(releases.length).toBeGreaterThanOrEqual(2);
      for (const release of releases) expect(release).toHaveBeenCalledTimes(1);
    } finally {
      failure.mockRestore();
      subscribe.mockRestore();
    }
    f.faux.setResponses([
      fauxAssistantMessage("Shared Harness remains available"),
    ]);
    await f.receive(update(1, "Continue"));
    await f.flush();
    expect(f.sent.map(({ text }) => text)).toEqual([
      "Shared Harness remains available",
    ]);
    expect(f.drafts).toHaveLength(0);
  });
}

test("Enforces a single writer and a stable Bot identity", async () => {
  const f = await fixture();
  await expect(openAgent(f.config, f.models)).rejects.toMatchObject({
    exitCode: 1,
    success: false,
  });
  const files = await readdir(f.config.stateDirectory);
  expect(files).toContain("amadeus.lock");
  expect(files).toContain("session.sqlite");
  expect(files).not.toContain("owner.sqlite");
  expect(files).not.toContain("state.sqlite");
  await f.close();
  await expect(f.open(1000)).rejects.toThrow(ZodError);
  await f.open();
});
