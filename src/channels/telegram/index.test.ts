import { afterEach, expect, spyOn, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TextContent } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  defineExtension,
  defineTool,
  type Registry,
} from "@earendil-works/pi-durable";
import { Bot } from "grammy";
import type { Message, Update, UserFromGetMe } from "grammy/types";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z, ZodError } from "zod";
import { openAgent, type Agent } from "../../agent";
import { parseConfig, telegramConfigSchema } from "../../config";
import { configureTelegram, runTelegram } from ".";
import { TelegramState } from "./conversations";
import type { DeliveryTask } from "./delivery";
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
const messageSchema = z.object({
  chat_id: z.number(),
  text: z.string(),
  message_thread_id: z.number().optional(),
});
const actionSchema = z.object({
  chat_id: z.number(),
  action: z.literal("typing"),
  message_thread_id: z.number().optional(),
});
type ChatAction = z.infer<typeof actionSchema>;
type SentMessage = z.infer<typeof messageSchema>;
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
        ? { id: -1, type: "group", title: "群组" }
        : { id: userId, type: "private", first_name: "用户" },
      from: { id: userId, is_bot: isBot, first_name: "用户" },
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
      chat: { id: 1, type: "private", first_name: "用户" },
      from: { id: 1, is_bot: false, first_name: "用户" },
    },
  };
}

function photoUpdate(id: number, caption = ""): Update {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1,
      chat: { id: 1, type: "private", first_name: "用户" },
      from: { id: 1, is_bot: false, first_name: "用户" },
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
    text: `[Telegram #${id} 用户 id:1 Thu 1970-01-01 00:00:01Z]${text ? ` ${text}` : ""}`,
  };
}

async function fixture(inputWindowMs = 0, imageInput = true) {
  const directory = await mkdtemp(join(tmpdir(), "amadeus-test-"));
  const config = parseConfig(
    {
      channels: {
        telegram: { token: "123:TEST", allowedUserIds: [1, 2], inputWindowMs },
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
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const sent: SentMessage[] = [];
  const actions: ChatAction[] = [];
  const downloads: string[] = [];
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
      const payload = messageSchema.parse(await request.json());
      await beforeSend?.(payload, request.signal);
      if (request.signal.aborted) return new Response(null, { status: 499 });
      sent.push(payload);
      onSent?.(payload);
      return Response.json({
        ok: true,
        result: {
          message_id: sent.length,
          date: 1,
          chat: { id: payload.chat_id, type: "private", first_name: "用户" },
          text: payload.text,
        },
      });
    },
  });
  let agent: Agent;
  let bot: Bot;
  async function open(botId = botInfo.id): Promise<void> {
    const next = await openAgent(config, models);
    const client = new Bot(telegram.token, {
      botInfo: { ...botInfo, id: botId },
      client: { apiRoot: server.url.origin },
    });
    try {
      await configureTelegram(client, next, telegram);
    } catch (error) {
      await next.close();
      throw error;
    }
    agent = next;
    bot = client;
    agent.harness.resume();
  }
  cleanups.push(async () => {
    try {
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
    close: () => agent.close(),
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
        inspection.tasks.map(({ record }) =>
          agent.harness.waitForTask(record.id, BACKGROUND_CONTEXT),
        ),
      );
    },
  };
}

test("正在输入覆盖合批、模型和发送，按话题共享并每四秒续期", async () => {
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
      return fauxAssistantMessage("完整回复");
    },
  ]);
  f.beforeSend(async () => {
    sending.resolve();
    await releaseSend.promise;
  });
  try {
    await f.receive(update(1, "第一条", 1, false, false, 7));
    await initial.promise;
    expect(f.faux.state.callCount).toBe(0);
    await f.receive(update(2, "第二条", 1, false, false, 7));
    await f.receive(update(2, "第二条", 1, false, false, 7));
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
    expect(f.sent.map(({ text }) => text)).toEqual(["完整回复"]);
  } finally {
    releaseModel.resolve();
    releaseSend.resolve();
    typing.mockRestore();
  }
}, 10_000);

test("停止、重置和关闭会取消正在输入，重启恢复无需新消息", async () => {
  const f = await fixture(60_000);
  const typing = spyOn(f.api, "sendChatAction");
  let id = 0;
  try {
    for (const command of ["/stop", "/new"]) {
      const shown = Promise.withResolvers<void>();
      f.onAction(() => shown.resolve());
      await f.receive(update(++id, "等待处理", 1, false, false, 7));
      await shown.promise;
      const signal = typing.mock.calls.at(-1)?.[3];
      expect(signal?.aborted).toBe(false);
      await f.receive(update(++id, command, 1, false, false, 7));
      await f.flush();
      expect(signal?.aborted).toBe(true);
    }
    const shown = Promise.withResolvers<void>();
    f.onAction(() => shown.resolve());
    await f.receive(update(++id, "等待恢复", 1, false, false, 7));
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

test("正在输入请求不阻塞回答，失败只原样报告而不影响 Agent", async () => {
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
      return fauxAssistantMessage("请求未返回也能回答");
    },
  ]);
  try {
    await f.receive(update(1, "第一条"));
    await f.flush();
    expect(f.sent.map(({ text }) => text)).toEqual(["请求未返回也能回答"]);
    expect(typing.mock.calls[0]?.[3]?.aborted).toBe(true);
    pending.resolve(true);
    typing.mockRejectedValue(failure);
    f.faux.setResponses([
      async () => {
        await reported.promise;
        return fauxAssistantMessage("状态失败仍能回答");
      },
    ]);
    await f.receive(update(2, "第二条"));
    await f.flush();
    expect(reports).toHaveBeenCalledWith(failure);
    expect(f.sent.at(-1)?.text).toBe("状态失败仍能回答");
    expect(f.faux.state.callCount).toBe(2);
  } finally {
    attempted.resolve();
    reported.resolve();
    pending.resolve(true);
    typing.mockRestore();
    reports.mockRestore();
  }
});

test("Telegram 接入响应宿主取消，启动错误原样抛出且不启动轮询", async () => {
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
    } finally {
      controller.abort();
      commands.mockRestore();
      polling.mockRestore();
    }
  }
});

test("宿主取消真实 Telegram 启动请求时正常退出", async () => {
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

test("只允许白名单用户通过私聊调用 Agent", async () => {
  const f = await fixture();
  f.faux.setResponses([fauxAssistantMessage("收到")]);
  await f.receive(update(1, "允许的消息"));
  await f.receive(update(2, "未授权", 3));
  await f.receive(update(3, "群消息", 1, true));
  await f.receive(update(4, "Bot 消息", 1, false, true));
  await f.flush();
  expect(f.faux.state.callCount).toBe(1);
  expect(f.sent.map((message) => message.text)).toEqual(["收到"]);
  expect(f.actions.every(({ chat_id }) => chat_id === 1)).toBe(true);
});

test("只读命令和参数错误直接回复，重复 update 不触发处理去重或发送任务", async () => {
  const f = await fixture();
  await f.receive(update(1, "/help", 1, false, false, 7));
  await f.receive(update(1, "/help", 1, false, false, 7));
  await f.receive(update(2, "/status", 1, false, false, 7));
  await f.receive(update(2, "/status", 1, false, false, 7));
  await f.receive(update(3, "/new 参数", 1, false, false, 7));
  await f.receive(update(3, "/new 参数", 1, false, false, 7));
  await f.receive(update(4, "/unknown"));
  expect(f.sent).toHaveLength(6);
  expect(f.sent.every((message) => message.message_thread_id === 7)).toBe(true);
  expect(f.sent.at(-1)?.text).toBe("该命令不接受参数。");
  expect(f.faux.state.callCount).toBe(0);
  expect(f.actions).toHaveLength(0);
  const tasks = await f.harness.commit(
    (tx) => tx.scanTasks({}, 1),
    BACKGROUND_CONTEXT,
  );
  expect(tasks.items).toHaveLength(0);
});

test("会话按聊天和话题隔离，重启后保留上下文与更新去重", async () => {
  const f = await fixture();
  f.faux.setResponses(
    Array.from({ length: 3 }, () => (context) => {
      expect(
        context.messages.filter((message) => message.role === "user"),
      ).toHaveLength(1);
      return fauxAssistantMessage("收到");
    }),
  );
  await f.receive(update(1, "用户一"));
  await f.receive(update(2, "用户二", 2));
  await f.receive(update(3, "另一个话题", 1, false, false, 7));
  await f.flush();
  await f.close();
  await f.open();
  f.faux.setResponses([
    (context) => {
      expect(
        context.messages
          .filter((message) => message.role === "user")
          .map((message) => message.content),
      ).toEqual([[inputText(1, "用户一")], [inputText(4, "继续")]]);
      return fauxAssistantMessage("继续回复");
    },
  ]);
  await f.receive(update(1, "用户一"));
  await f.receive(update(4, "继续"));
  await f.flush();
  expect(f.faux.state.callCount).toBe(4);
  expect(f.sent).toHaveLength(4);
});

test("/new 重置上下文，重复更新不会再次执行重置", async () => {
  const f = await fixture();
  f.faux.setResponses([fauxAssistantMessage("旧回复")]);
  await f.receive(update(1, "旧消息"));
  await f.flush();
  await f.receive(update(2, "/new"));
  await f.flush();
  f.faux.setResponses([
    (context) => {
      expect(
        context.messages
          .filter((message) => message.role === "user")
          .map((message) => message.content),
      ).toEqual([[inputText(3, "新消息")]]);
      return fauxAssistantMessage("新回复");
    },
    (context) => {
      expect(
        context.messages
          .filter((message) => message.role === "user")
          .map((message) => message.content),
      ).toEqual([[inputText(3, "新消息")], [inputText(4, "继续")]]);
      return fauxAssistantMessage("继续回复");
    },
  ]);
  await f.receive(update(3, "新消息"));
  await f.flush();
  await f.close();
  await f.open();
  await f.receive(update(2, "/new"));
  await f.receive(update(4, "继续"));
  await f.flush();
  expect(
    f.sent.filter((message) => message.text === "已开启新会话。"),
  ).toHaveLength(1);
});

test("模型运行时可查看状态，并能停止运行和排队输入", async () => {
  const f = await fixture();
  const started = Promise.withResolvers<void>();
  const status = Promise.withResolvers<void>();
  f.onSent((message) => {
    if (message.text.includes("状态：正在处理")) status.resolve();
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
      return fauxAssistantMessage("这条不应发送");
    },
  ]);
  await f.receive(update(1, "慢请求"));
  await started.promise;
  await f.receive(update(2, "排队请求"));
  await f.prepare();
  await f.receive(update(3, "/status"));
  await status.promise;
  expect(f.sent.at(-1)?.text).toContain("排队输入：1");
  await f.receive(update(4, "/stop"));
  await f.flush();
  expect(f.sent.at(-1)?.text).toBe("已停止当前任务。");
  expect(f.sent.some((message) => message.text === "这条不应发送")).toBe(false);
  expect(f.faux.state.callCount).toBe(1);
});

test("成功回复属于当前运行，发送完成前排队输入不启动，重复输入不另发回复", async () => {
  const f = await fixture();
  const blocked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.beforeSend(async (message) => {
    if (message.text === "第一条回复") {
      blocked.resolve();
      await release.promise;
    }
  });
  f.faux.setResponses([
    fauxAssistantMessage("第一条回复"),
    fauxAssistantMessage("第二条回复"),
  ]);
  await f.receive(update(1, "第一条输入"));
  await blocked.promise;
  let idle = false;
  const waiting = f.harness.waitForIdle(BACKGROUND_CONTEXT).then(() => {
    idle = true;
  });
  try {
    await f.receive(update(1, "第一条输入"));
    await f.receive(update(2, "第二条输入"));
    await f.prepare();
    await f.receive(update(3, "/status"));
    expect(f.sent.at(-1)?.text).toContain("状态：正在处理");
    expect(f.sent.at(-1)?.text).toContain("排队输入：1");
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
    "第一条回复",
    "第二条回复",
  ]);
  expect(f.faux.state.callCount).toBe(2);
});

test("/stop 取消运行结束时的发送，并撤回排队输入", async () => {
  const f = await fixture();
  const blocked = Promise.withResolvers<void>();
  f.beforeSend(async (message, signal) => {
    if (message.text !== "不应发送的回复") return;
    blocked.resolve();
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  f.faux.setResponses([fauxAssistantMessage("不应发送的回复")]);
  await f.receive(update(1, "正在发送"));
  await blocked.promise;
  await f.receive(update(2, "排队输入"));
  await f.receive(update(3, "/stop"));
  await f.flush();
  expect(f.sent.map((message) => message.text)).toEqual(["已停止当前任务。"]);
  expect(f.faux.state.callCount).toBe(1);
  f.beforeSend();
  f.faux.setResponses([fauxAssistantMessage("停止后可继续")]);
  await f.receive(update(4, "继续"));
  await f.flush();
  expect(f.sent.at(-1)?.text).toBe("停止后可继续");
});

test("长回复按字符边界分段，重启后从未确认的分段继续发送", async () => {
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
  f.faux.setResponses([fauxAssistantMessage(first + second)]);
  await f.receive(update(1, "长回复"));
  await blocked.promise;
  await f.close();
  expect(f.sent.map((message) => message.text)).toEqual([first]);
  f.beforeSend();
  await f.open();
  await f.flush();
  expect(f.sent.map((message) => message.text)).toEqual([first, second]);
  expect(f.faux.state.callCount).toBe(1);
});

test("模型错误原样发送，通知可在重启后恢复且重复输入不另建通知", async () => {
  const f = await fixture();
  const error =
    '400: {"error":{"message":"invalid model","type":"invalid_request_error"}}\n原始错误详情';
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
  await f.receive(update(1, "触发模型错误"));
  await blocked.promise;
  await f.receive(update(1, "触发模型错误"));
  await f.close();
  f.beforeSend();
  await f.open();
  await f.receive(update(1, "触发模型错误"));
  await f.flush();
  expect(f.sent.map((message) => message.text)).toEqual([error]);
  expect(f.faux.state.callCount).toBe(1);
});

test("固定窗口合批且不滑动，收集状态和逐条去重在重启后保留", async () => {
  const f = await fixture(700);
  f.faux.setResponses([
    (context) => {
      const users = context.messages.filter(
        (message) => message.role === "user",
      );
      expect(users.map((message) => message.content)).toEqual([
        [
          inputText(1, "第一条"),
          inputText(2, "第二条"),
          inputText(3, "第三条"),
        ],
      ]);
      return fauxAssistantMessage("合并回复");
    },
  ]);
  await f.receive(update(1, "第一条"));
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
    await f.receive(update(2, "第二条"));
    await f.receive(update(1, "第一条"));
    await f.receive(update(4, "/status"));
    expect(f.sent.at(-1)?.text).toContain("收集消息：2");
    expect(f.faux.state.callCount).toBe(0);
    await f.close();
    await f.open();
    await f.receive(update(2, "第二条"));
    await f.receive(update(3, "第三条"));
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
      inputText(1, "第一条").text,
      inputText(2, "第二条").text,
      inputText(3, "第三条").text,
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
  expect(f.sent.at(-1)?.text).toBe("合并回复");
});

test("图片、caption 和另发文字合成一个多模态输入，下载地址不进入模型", async () => {
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
          attachmentText(1, "图片说明"),
          inputText(2, "补充文字"),
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
      return fauxAssistantMessage("看到了两张图和文字");
    },
  ]);
  await f.receive(photoUpdate(1, "图片说明"));
  await f.receive(update(2, "补充文字"));
  await f.receive(photoUpdate(3));
  await f.flush();
  expect(f.downloads).toEqual(["photo-1", "photo-3"]);
  expect(f.faux.state.callCount).toBe(1);
  expect(f.sent.map((message) => message.text)).toEqual(["看到了两张图和文字"]);
});

for (const stopReason of ["stop", "error"] satisfies ("stop" | "error")[]) {
  test(`模型运行中补充不抢占，未入队的新批次也会抑制旧${stopReason === "stop" ? "回答" : "错误"}`, async () => {
    const f = await fixture(700);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    f.faux.setResponses([
      async (_context, options) => {
        signal = options?.signal;
        started.resolve();
        await release.promise;
        return fauxAssistantMessage("旧回答", {
          stopReason,
          ...(stopReason === "error" ? { errorMessage: "旧请求错误" } : {}),
        });
      },
      (context) => {
        expect(
          context.messages
            .filter((message) => message.role === "user")
            .map((message) => message.content),
        ).toEqual([
          [inputText(1, "原问题")],
          [inputText(2, "补充一"), inputText(3, "补充二")],
        ]);
        return fauxAssistantMessage("基于全部输入的回复");
      },
    ]);
    await f.receive(update(1, "原问题"));
    await started.promise;
    const generations = (
      await f.harness.inspect(BACKGROUND_CONTEXT)
    ).tasks.filter(({ record }) => record.kind === "pi.generation");
    try {
      await f.receive(update(2, "补充一"));
      await f.receive(update(3, "补充二"));
      expect(signal?.aborted).toBe(false);
      release.resolve();
      await Promise.all(
        generations.map(({ record }) =>
          f.harness.waitForTask(record.id, BACKGROUND_CONTEXT),
        ),
      );
      await f.flush();
      expect(f.sent.map((message) => message.text)).toEqual([
        "基于全部输入的回复",
      ]);
      expect(f.faux.state.callCount).toBe(2);
    } finally {
      release.resolve();
    }
  });
}

test("准备和等待中的批次重启后保留收据，慢图片不被后批文字越过", async () => {
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
      return fauxAssistantMessage("旧图片回复");
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
      expect(users[1]?.content).toEqual([inputText(2, "解释这张图")]);
      return fauxAssistantMessage("完整图片回复");
    },
  ]);
  try {
    await f.receive(photoUpdate(1));
    await downloading.promise;
    await f.receive(update(2, "解释这张图"));
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
      "完整图片回复",
    ]);
  } finally {
    releasePhoto.resolve();
    releaseModel.resolve();
  }
});

test("工具不中断，边界接纳全部 steer 并用最新输入水位发送一次最终回复", async () => {
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
      return { output: [{ type: "text", text: "工具完成" }] };
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
        [inputText(1, "执行工具")],
        [inputText(2, "补充一")],
        [inputText(3, "补充二")],
      ]);
      return fauxAssistantMessage("工具及全部补充处理完成");
    },
  ]);
  try {
    await f.receive(update(1, "执行工具"));
    await started.promise;
    const signal = typing.mock.calls[0]?.[3];
    expect(signal?.aborted).toBe(false);
    await f.receive(update(2, "补充一"));
    await f.receive(update(3, "补充二"));
    await f.prepare();
    expect(signal?.aborted).toBe(false);
    release.resolve();
    await f.flush();
    expect(signal?.aborted).toBe(true);
    expect(executions).toBe(1);
    expect(f.sent.map((message) => message.text)).toEqual([
      "工具及全部补充处理完成",
    ]);
  } finally {
    release.resolve();
    typing.mockRestore();
  }
});

test("/stop 和 /new 跳过收集窗口，重启或重复 update 不会复活已取消输入", async () => {
  const f = await fixture(700);
  await f.receive(update(1, "取消的输入"));
  await f.receive(update(2, "/stop"));
  await f.close();
  await f.open();
  await f.receive(update(1, "取消的输入"));
  await f.receive(update(2, "/stop"));
  await f.flush();
  expect(f.faux.state.callCount).toBe(0);
  await f.receive(update(3, "重置前输入"));
  await f.receive(update(4, "/new"));
  await f.close();
  await f.open();
  await f.receive(update(3, "重置前输入"));
  f.faux.setResponses([
    (context) => {
      expect(
        context.messages
          .filter((message) => message.role === "user")
          .map((message) => message.content),
      ).toEqual([[inputText(5, "有效输入")]]);
      return fauxAssistantMessage("有效回复");
    },
  ]);
  await f.receive(update(5, "有效输入"));
  await f.flush();
  expect(f.sent.map((message) => message.text)).toEqual([
    "已停止当前任务。",
    "已开启新会话。",
    "有效回复",
  ]);
  expect(f.faux.state.callCount).toBe(1);
});

test("下载图片时仍可接收命令，停止会取消下载并允许后续输入", async () => {
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
  f.faux.setResponses([fauxAssistantMessage("新图片回复")]);
  await f.receive(photoUpdate(3));
  await f.flush();
  expect(f.sent.map((message) => message.text)).toEqual([
    "已停止当前任务。",
    "新图片回复",
  ]);
});

test("输入提交错误交给框架，不转换成图片准备失败或用户通知", async () => {
  const f = await fixture();
  const error = { message: "commit failure", detail: { stage: "input" } };
  // Registry 的 AnyTask 擦除了泛型；该名称只由当前 DeliveryTask 注册。
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
    await f.receive(update(1, "提交失败"));
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

test("图片准备失败原样通知，不启动模型也不阻塞后续批次", async () => {
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
  f.faux.setResponses([fauxAssistantMessage("继续回复")]);
  await f.receive(update(2, "继续"));
  await f.flush();
  expect(f.sent.at(-1)?.text).toBe("继续回复");
});

test("结构化内容以元数据进入模型，当前字段完整持久化且重启去重", async () => {
  const f = await fixture(700);
  const bodies = [
    {
      contact: {
        phone_number: "+8612345",
        first_name: "联系人",
        user_id: 42,
        vcard: "BEGIN:VCARD",
      },
    },
    { location: { latitude: 31.2, longitude: 121.5, horizontal_accuracy: 10 } },
    { dice: { emoji: String.fromCodePoint(0x1f3b2), value: 3 } },
    {
      poll: {
        id: "poll",
        question: "选择？",
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
      return fauxAssistantMessage("已收到元数据");
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
  expect(f.sent.at(-1)?.text).toBe("已收到元数据");
});

test("服务与命令仅记录，服务消息不触发输入或抑制在途回答", async () => {
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
        chat: { id: 1, type: "private", first_name: "用户" },
        text: "不复制旧消息",
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
  expect(JSON.stringify(received)).not.toContain("不复制旧消息");
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.faux.setResponses([
    async () => {
      started.resolve();
      await release.promise;
      return fauxAssistantMessage("正常回复");
    },
  ]);
  try {
    await f.receive(update(4, "提问"));
    await started.promise;
    await f.receive(messageUpdate(5, { forum_topic_closed: {} }));
    release.resolve();
    await f.flush();
    expect(f.sent.at(-1)?.text).toBe("正常回复");
    expect(f.faux.state.callCount).toBe(1);
  } finally {
    release.resolve();
  }
});

test("文件先落盘再交原生 read，路径与元数据持久化，重置与重启不删附件或重复下载", async () => {
  const f = await fixture();
  const body = "附件中的独特正文";
  f.beforePhoto(async () => new Response(body));
  let path = "";
  f.faux.setResponses([
    async (context) => {
      const uploads = (await f.entries()).filter(Uploaded.is);
      expect(uploads).toHaveLength(1);
      const file = uploads[0]?.data.files[0];
      expect(file).toBeDefined();
      if (!file) return fauxAssistantMessage("缺少附件");
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
      return fauxAssistantMessage("已通过工具读取");
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
    caption: "读取附件",
  });
  await f.receive(incoming);
  await f.flush();
  expect(f.sent.at(-1)?.text).toBe("已通过工具读取");
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
  test(`图片原件保留，${imageInput ? "支持视觉时附原生图片" : "纯文本模型只接收文件引用"}`, async () => {
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
        return fauxAssistantMessage("收到原件");
      },
    ]);
    await f.receive(photoUpdate(1));
    await f.flush();
    const uploads = (await f.entries()).filter(Uploaded.is);
    const file = uploads[0]?.data.files[0];
    expect(file?.mimeType).toBe("image/png");
    expect(file && (await Bun.file(file.path).exists())).toBe(true);
    expect(f.sent.at(-1)?.text).toBe("收到原件");
  });
}

test("接收图片与原生 read 共享同一个 Photon 处理器", async () => {
  const f = await fixture();
  const prepare = spyOn(f.images, "prepare");
  f.faux.setResponses([
    async () => {
      const files = (await f.entries())
        .filter(Uploaded.is)
        .flatMap(({ data }) => data.files);
      expect(files).toHaveLength(1);
      const file = files[0];
      if (!file) return fauxAssistantMessage("缺少附件");
      return fauxAssistantMessage(fauxToolCall("read", { path: file.path }), {
        stopReason: "toolUse",
      });
    },
    fauxAssistantMessage("图片处理完成"),
  ]);
  try {
    await f.receive(photoUpdate(1));
    await f.flush();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(f.sent.at(-1)?.text).toBe("图片处理完成");
  } finally {
    prepare.mockRestore();
  }
});

test("语音、视频、动画贴纸只交文件引用，无法下载的预览仍交元数据", async () => {
  const f = await fixture(700);
  f.beforePhoto(async () => new Response("原始附件"));
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
      return fauxAssistantMessage("已收到附件");
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
  expect(f.sent.at(-1)?.text).toBe("已收到附件");
});

test("同批部分附件已落盘后重启复用原件，未完成附件继续下载", async () => {
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
  f.faux.setResponses([fauxAssistantMessage("附件已恢复")]);
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
  expect(f.sent.at(-1)?.text).toBe("附件已恢复");
});

test("升级前已排队的图片收据重启后仍可落盘与输入，不迁移历史条目", async () => {
  const f = await fixture();
  const root = await f.harness.root(BACKGROUND_CONTEXT, {
    agent: { model: f.config.agent.model },
  });
  // 此注册名称只对应当前 BatchTask；Registry 查询会擦除任务泛型。
  const batch = f.registry
    .snapshot()
    .task("amadeus.telegram.collect") as BatchTask;
  f.faux.setResponses([fauxAssistantMessage("旧收据已恢复")]);
  await root.commit(async (tx) => {
    const id = await root.submit(tx, {
      type: "write",
      requestId: "legacy-receipt",
      entry: {
        kind: Received.kind,
        data: { text: "旧图片", photo: "legacy-photo" },
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
  expect(f.sent.at(-1)?.text).toBe("旧收据已恢复");
});

test("状态目录只能由一个进程及同一个 Bot 使用", async () => {
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
