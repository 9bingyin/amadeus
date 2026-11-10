import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { Bot } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z, ZodError } from "zod";
import { openAgent, type Agent } from "../agent";
import { parseConfig } from "../config";
import { configureTelegram } from ".";

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

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "amadeus-test-"));
  const config = parseConfig(
    {
      telegram: { allowedUserIds: [1, 2] },
      model: { id: "test" },
      stateDirectory: directory,
    },
    directory,
  );
  const faux = fauxProvider({ provider: "openai", models: [{ id: "test" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const sent: SentMessage[] = [];
  let beforeSend:
    ((message: SentMessage, signal: AbortSignal) => Promise<void>) | undefined;
  let onSent: ((message: SentMessage) => void) | undefined;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
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
    const client = new Bot("123:TEST", {
      botInfo: { ...botInfo, id: botId },
      client: { apiRoot: server.url.origin },
    });
    try {
      await configureTelegram(client, next, config.telegram.allowedUserIds);
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
    get harness() {
      return agent.harness;
    },
    open,
    close: () => agent.close(),
    receive: (incoming: Update) => bot.handleUpdate(incoming),
    beforeSend(handler?: typeof beforeSend) {
      beforeSend = handler;
    },
    onSent(handler: NonNullable<typeof onSent>) {
      onSent = handler;
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
});

test("普通命令直接回复，不创建持久化发送任务", async () => {
  const f = await fixture();
  await f.receive(update(1, "/help", 1, false, false, 7));
  await f.receive(update(1, "/help", 1, false, false, 7));
  await f.receive(update(2, "/status", 1, false, false, 7));
  await f.receive(update(3, "/new 参数", 1, false, false, 7));
  await f.receive(update(4, "/unknown"));
  expect(f.sent).toHaveLength(3);
  expect(f.sent.every((message) => message.message_thread_id === 7)).toBe(true);
  expect(f.sent.at(-1)?.text).toBe("该命令不接受参数。");
  expect(f.faux.state.callCount).toBe(0);
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
      ).toEqual(["用户一", "继续"]);
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
      ).toEqual(["新消息"]);
      return fauxAssistantMessage("新回复");
    },
    (context) => {
      expect(
        context.messages
          .filter((message) => message.role === "user")
          .map((message) => message.content),
      ).toEqual(["新消息", "继续"]);
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
