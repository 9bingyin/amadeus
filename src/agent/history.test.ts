import { afterEach, expect, spyOn, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { contentText } from "@earendil-works/pi-ai/utils/text";
import type {
  Message,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  CompactionEntry,
  createRegistry,
  Harness,
  type Conversation,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createHistoryExtension } from "./history";

const context = BACKGROUND_CONTEXT;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const messageSchema = z.object({
  entryId: z.int(),
  messageIndex: z.int(),
  role: z.enum(["user", "assistant"]),
  timestamp: z.number(),
  text: z.string(),
});
const readSchema = z.object({
  messages: z.array(messageSchema),
  cursor: z.string().nullable(),
});
const searchSchema = z.object({
  matches: z.array(
    messageSchema.omit({ text: true }).extend({ snippet: z.string() }),
  ),
  cursor: z.string().nullable(),
});
function user(text: string): UserMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "amadeus-history-test-"));
  const faux = fauxProvider({ provider: "test", models: [{ id: "test" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const agent = { model: { provider: "test", modelId: "test" } };
  let database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>;
  let harness: Harness;
  let root: Conversation;
  async function open() {
    database = await openNodeSqliteDatabase(join(directory, "session.sqlite"));
    const storage = await SqliteStorage.open(database);
    const registry = createRegistry();
    registry.install(await createHistoryExtension(database));
    harness = await Harness.open(storage, { models, registry }, context);
    root = await harness.root(context, { agent });
    harness.resume();
  }
  cleanups.push(async () => {
    try {
      await harness?.close(context);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await open();
  async function tool(
    name: string,
    args: Parameters<typeof fauxToolCall>[1],
    conversation = root,
  ) {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await (
      await conversation.submit(
        { type: "input", content: "history operation" },
        context,
      )
    ).wait(context);
    const result = (await conversation.context(context)).messages.findLast(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolName === name,
    );
    if (!result) throw new Error("Missing tool result");
    return result;
  }
  return {
    faux,
    agent,
    get root() {
      return root;
    },
    get harness() {
      return harness;
    },
    get database() {
      return database;
    },
    tool,
    async seed(model: readonly Message[], conversation = root) {
      return conversation.commit(
        (tx) => tx.appendEntry(conversation.id, { kind: "app.history", model }),
        context,
      );
    },
    async read(
      args: Parameters<typeof fauxToolCall>[1] = {},
      conversation = root,
    ) {
      const result = await tool("session_read", args, conversation);
      expect(result.isError).toBe(false);
      return readSchema.parse(JSON.parse(contentText(result.content)));
    },
    async search(
      query: string,
      args: Parameters<typeof fauxToolCall>[1] = {},
      conversation = root,
    ) {
      const result = await tool(
        "session_search",
        { ...args, query },
        conversation,
      );
      expect(result.isError).toBe(false);
      return searchSchema.parse(JSON.parse(contentText(result.content)));
    },
    async reopen() {
      await harness.close(context);
      await open();
    },
  };
}

test("历史读取跨 reset 和 compaction 保留原文，不返回 thinking、工具输出或失败片段", async () => {
  const f = await fixture();
  const saved = await f.seed([
    user("  原始用户正文\n保留空白  "),
    fauxAssistantMessage([
      { type: "text", text: "旧助手正文" },
      { type: "thinking", thinking: "THINKING_SECRET" },
    ]),
    {
      role: "toolResult",
      toolCallId: "old",
      toolName: "bash",
      content: [{ type: "text", text: "TOOL_SECRET" }],
      isError: false,
      timestamp: 3,
    },
    fauxAssistantMessage("ABORTED_SECRET", { stopReason: "aborted" }),
    fauxAssistantMessage("ERROR_SECRET", { stopReason: "error" }),
  ]);
  await f.root.reset("HANDOFF_SECRET", context);
  await f.seed([user("新用户正文")]);
  await f.root.commit(
    (tx) =>
      tx.appendEntry(f.root.id, {
        kind: CompactionEntry.kind,
        head: "self",
        data: { reason: "manual" },
        model: [user("COMPACTION_SECRET")],
      }),
    context,
  );
  const read = await f.read();
  expect(read.messages.slice(0, 3).map(({ text }) => text)).toEqual([
    "  原始用户正文\n保留空白  ",
    "旧助手正文",
    "新用户正文",
  ]);
  expect(read.messages[0]?.entryId).toBe(saved.id);
  expect(read.messages[1]?.messageIndex).toBe(1);
  const text = JSON.stringify(read);
  for (const secret of [
    "THINKING_SECRET",
    "TOOL_SECRET",
    "ABORTED_SECRET",
    "ERROR_SECRET",
    "HANDOFF_SECRET",
    "COMPACTION_SECRET",
  ])
    expect(text).not.toContain(secret);
  expect((await f.search("原始用户")).matches).toHaveLength(1);
  expect((await f.search("SECRET")).matches).toHaveLength(0);
});

test("FTS5 支持中文子串、短查询、大小写及字面标点，不执行查询语法", async () => {
  const f = await fixture();
  await f.seed([user('数据库迁移方案 AlphaTimeout abc_def 100% a"b')]);
  for (const query of [
    "数据库",
    "迁移",
    "ALPHATIMEOUT",
    "abc_def",
    "100%",
    'a"b',
    "%",
    "_",
  ]) {
    const result = await f.search(query);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.role).toBe("user");
  }
  expect((await f.search("' OR 1=1 --")).matches).toHaveLength(0);
  expect((await f.search('"')).matches).toHaveLength(1);
  expect((await f.search("不存在")).matches).toHaveLength(0);
});

test("历史工具始终限定当前 Conversation，不能读取其他聊天的 entryId", async () => {
  const f = await fixture();
  const own = await f.seed([user("own-private-keyword")]);
  const other = await f.harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: f.agent },
    context,
  );
  const foreign = await f.seed([user("foreign-private-keyword")], other);
  expect((await f.search("foreign-private-keyword")).matches).toHaveLength(0);
  expect(
    (await f.search("own-private-keyword", {}, other)).matches,
  ).toHaveLength(0);
  expect(
    (await f.read({}, other)).messages.some(({ text }) =>
      text.includes("own-private"),
    ),
  ).toBe(false);
  const rejected = await f.tool("session_read", { fromEntryId: foreign.id });
  expect(rejected.isError).toBe(true);
  expect(contentText(rejected.content)).not.toContain(
    "foreign-private-keyword",
  );
  expect((await f.read({ fromEntryId: own.id })).messages[0]?.text).toBe(
    "own-private-keyword",
  );
});

test("读取游标分页保留同一 entry 的多条消息，并固定快照避免追赶自身工具调用", async () => {
  const f = await fixture();
  const saved = await f.seed(
    Array.from({ length: 7 }, (_, index) => user(`分页消息-${index}`)),
  );
  let page = await f.read({ fromEntryId: saved.id, limit: 2 });
  const all = [...page.messages];
  await f.reopen();
  await f.seed([user("SNAPSHOT_LATER")]);
  while (page.cursor !== null) {
    page = await f.read({ cursor: page.cursor, limit: 2 });
    all.push(...page.messages);
  }
  expect(
    all.filter(({ entryId }) => entryId === saved.id).map(({ text }) => text),
  ).toEqual(Array.from({ length: 7 }, (_, index) => `分页消息-${index}`));
  expect(all.filter(({ text }) => text === "history operation")).toHaveLength(
    1,
  );
  expect(all.some(({ text }) => text === "SNAPSHOT_LATER")).toBe(false);
});

test("搜索按新到旧稳定分页，增量索引新记录但不污染旧游标快照", async () => {
  const f = await fixture();
  const saved = await f.seed(
    Array.from({ length: 5 }, (_, index) => user(`搜索分页-${index}`)),
  );
  let page = await f.search("搜索分页", { limit: 2 });
  const all = [...page.matches];
  await f.reopen();
  await f.seed([user("搜索分页-新追加")]);
  while (page.cursor !== null) {
    page = await f.search("搜索分页", { cursor: page.cursor, limit: 2 });
    all.push(...page.matches);
  }
  expect(all.map(({ messageIndex }) => messageIndex)).toEqual([4, 3, 2, 1, 0]);
  expect(all.every(({ entryId }) => entryId === saved.id)).toBe(true);
  expect((await f.search("搜索分页")).matches).toHaveLength(6);
});

test("原生重启保留索引并增量补齐，丢失派生索引后仍可从原始历史重建", async () => {
  const f = await fixture();
  const old = await f.seed([user("持久化索引-keyword")]);
  expect((await f.search("持久化索引")).matches).toHaveLength(1);
  await f.reopen();
  await f.root.reset(undefined, context);
  await f.seed([user("持久化索引-new")]);
  expect((await f.search("持久化索引")).matches).toHaveLength(2);
  await f.database.transaction((sql) =>
    sql.exec(
      "DELETE FROM amadeus_history_fts; DELETE FROM amadeus_history_position;",
    ),
  );
  expect((await f.search("持久化索引")).matches).toHaveLength(2);
  expect(await f.root.commit((tx) => tx.entry(old.id), context)).toEqual(old);
  const duplicates = await f.database.all(
    "SELECT entry_id, message_index FROM amadeus_history_fts GROUP BY conversation_id, entry_id, message_index HAVING count(*) > 1",
  );
  expect(duplicates).toHaveLength(0);
});

test("并行搜索跨多个原生历史页补索引，不重复记录或回退进度", async () => {
  const f = await fixture();
  await f.root.commit(async (tx) => {
    for (let index = 0; index < 270; index++)
      await tx.appendEntry(f.root.id, {
        kind: "app.history",
        model: [user(`并行搜索-keyword-${index}`)],
      });
  }, context);
  f.faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("session_search", { query: "并行搜索", limit: 300 }),
        fauxToolCall("session_search", { query: "并行搜索", limit: 300 }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
  ]);
  await (
    await f.root.submit(
      { type: "input", content: "parallel history operation" },
      context,
    )
  ).wait(context);
  const results = (await f.root.context(context)).messages.filter(
    (message): message is ToolResultMessage =>
      message.role === "toolResult" && message.toolName === "session_search",
  );
  expect(results).toHaveLength(2);
  for (const result of results) {
    expect(result.isError).toBe(false);
    expect(
      searchSchema.parse(JSON.parse(contentText(result.content))).matches,
    ).toHaveLength(270);
  }
  const count = await f.database.get<{ count: number }>(
    "SELECT count(*) AS count FROM amadeus_history_fts WHERE text LIKE '并行搜索-keyword-%'",
  );
  expect(count?.count).toBe(270);
});

test("索引及进度在同一事务，失败保留原错误且下一次可重新补齐", async () => {
  const f = await fixture();
  await f.seed([user("回滚索引-keyword")]);
  await f.database
    .exec(`CREATE TRIGGER history_failure BEFORE INSERT ON amadeus_history_position
    BEGIN SELECT RAISE(ABORT, 'history index failure'); END;`);
  const result = await f.tool("session_search", { query: "回滚索引" });
  expect(result.isError).toBe(true);
  expect(contentText(result.content)).toContain("history index failure");
  expect(
    (
      await f.database.get<{ count: number }>(
        "SELECT count(*) AS count FROM amadeus_history_fts",
      )
    )?.count,
  ).toBe(0);
  expect(
    (
      await f.database.get<{ count: number }>(
        "SELECT count(*) AS count FROM amadeus_history_position",
      )
    )?.count,
  ).toBe(0);
  await f.database.exec("DROP TRIGGER history_failure");
  expect((await f.search("回滚索引")).matches).toHaveLength(1);
});

test("取消索引准备不会写入派生数据，后续搜索正常恢复", async () => {
  const f = await fixture();
  await f.seed([user("取消索引-keyword")]);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const get = f.database.get.bind(f.database);
  const blocked = spyOn(f.database, "get").mockImplementation(
    async (sql, ...params) => {
      if (sql.startsWith("SELECT through FROM amadeus_history_position")) {
        entered.resolve();
        await release.promise;
      }
      return get(sql, ...params);
    },
  );
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("session_search", { query: "取消索引" }),
      { stopReason: "toolUse" },
    ),
  ]);
  const submitted = await f.root.submit(
    { type: "input", content: "cancel history operation" },
    context,
  );
  await entered.promise;
  const aborted = f.root.abort(context);
  release.resolve();
  await aborted;
  expect((await submitted.wait(context)).status).toBe("unanswered");
  blocked.mockRestore();
  expect(
    (
      await f.database.get<{ count: number }>(
        "SELECT count(*) AS count FROM amadeus_history_fts",
      )
    )?.count,
  ).toBe(0);
  expect((await f.search("取消索引")).matches).toHaveLength(1);
});

test("稀疏历史通过原生分页读取，不依赖 FTS 索引或重复展示收据", async () => {
  const f = await fixture();
  await f.root.commit(async (tx) => {
    for (let index = 0; index < 270; index++)
      await tx.appendEntry(f.root.id, {
        kind: "app.receipt",
        data: { text: "不重复展示" },
      });
  }, context);
  await f.seed([user("唯一可读正文")]);
  const read = await f.read();
  expect(read.messages[0]?.text).toBe("唯一可读正文");
  expect(JSON.stringify(read)).not.toContain("不重复展示");
  expect(
    (
      await f.database.get<{ count: number }>(
        "SELECT count(*) AS count FROM amadeus_history_fts",
      )
    )?.count,
  ).toBe(0);
});

test("分叉会话只索引原生可见历史，不包含父会话在分叉后的消息", async () => {
  const f = await fixture();
  const saved = await f.seed([user("分叉之前-keyword")]);
  const branch = await f.root.fork(
    saved.id,
    { ownership: { kind: "ownerless" } },
    context,
  );
  await f.seed([user("分叉之后-keyword")]);
  expect((await f.search("分叉之前", {}, branch)).matches).toHaveLength(1);
  expect((await f.search("分叉之后", {}, branch)).matches).toHaveLength(0);
  expect(
    (await f.read({ fromEntryId: saved.id }, branch)).messages[0]?.text,
  ).toBe("分叉之前-keyword");
});

test("历史工具校验空查询、分页参数与游标，无匹配时正常返回", async () => {
  const f = await fixture();
  for (const [name, args] of [
    ["session_search", { query: "   " }],
    ["session_search", { query: "test", limit: 0 }],
    ["session_read", { fromEntryId: 0 }],
    ["session_read", { cursor: "not-json" }],
    ["session_read", { cursor: "{}" }],
    ["session_read", { fromEntryId: 1, cursor: "{}" }],
  ] satisfies [string, Parameters<typeof fauxToolCall>[1]][]) {
    expect((await f.tool(name, args)).isError).toBe(true);
  }
  expect(
    (await f.search("never-existing-history-keyword")).matches,
  ).toHaveLength(0);
});
