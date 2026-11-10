import { afterEach, expect, spyOn, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { contentText } from "@earendil-works/pi-ai/utils/text";
import { LiveDoc, type LiveState } from "@earendil-works/pi-durable";
import { CodemodeStoreDoc } from "@earendil-works/pi-durable/codemode";
import {
  isJsonRpcRequest,
  LATEST_PROTOCOL_VERSION,
  McpAuthRequiredError,
  parseJsonRpcMessage,
} from "@earendil-works/pi-mcp";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { openAgent } from "../agent";
import { acquireLock } from "../agent/lock";
import { parseConfig } from "../config";

const context = BACKGROUND_CONTEXT;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const stdio = fileURLToPath(new URL("./fixtures/stdio.ts", import.meta.url));
const base = {
  channels: { telegram: { token: "123:TEST", allowedUserIds: [1] } },
  agent: { model: { provider: "openai", modelId: "test" } },
  providers: { openai: { apiKey: "test-key" } },
};
function call(name: string, args: Parameters<typeof fauxToolCall>[1]) {
  return fauxAssistantMessage(fauxToolCall(name, args), {
    stopReason: "toolUse",
  });
}
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "amadeus-mcp-test-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function fixture(mcpServers: Record<string, unknown>) {
  const config = parseConfig({ ...base, mcpServers }, await directory());
  const faux = fauxProvider({ provider: "openai", models: [{ id: "test" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  let agent = await openAgent(config, models);
  cleanups.push(() => agent.close());
  let root = await agent.harness.root(context, { agent: agent.configuration });
  agent.harness.resume();
  return {
    config,
    faux,
    get agent() {
      return agent;
    },
    get root() {
      return root;
    },
    async reopen() {
      await agent.close();
      agent = await openAgent(config, models);
      root = await agent.harness.root(context, { agent: agent.configuration });
      agent.harness.resume();
    },
    async submit(text: string) {
      const result = await (
        await root.submit({ type: "input", content: text }, context)
      ).wait(context);
      await agent.harness.waitForIdle(context);
      return result;
    },
  };
}

function remote(unauthorized = false) {
  const calls: string[] = [];
  const cancelled = Promise.withResolvers<void>();
  let slow: ReadableStreamDefaultController<Uint8Array> | undefined;
  let deleted = false;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (
        unauthorized ||
        request.headers.get("authorization") !== "Bearer configured"
      )
        return new Response("original unauthorized", { status: 401 });
      if (request.method === "GET") return new Response(null, { status: 405 });
      if (request.method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 200 });
      }
      const message = parseJsonRpcMessage(await request.json());
      if (!isJsonRpcRequest(message)) {
        if (
          "method" in message &&
          message.method === "notifications/cancelled"
        ) {
          cancelled.resolve();
          slow?.close();
          slow = undefined;
        }
        return new Response(null, { status: 202 });
      }
      let result: unknown;
      if (message.method === "initialize")
        result = {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "remote-fixture", version: "1" },
          instructions: "Remote fixture instructions",
        };
      else if (message.method === "tools/list")
        result = {
          tools: [
            {
              name: "sum",
              description: "Add two numbers",
              inputSchema: {
                type: "object",
                properties: { a: { type: "number" }, b: { type: "number" } },
                required: ["a", "b"],
              },
              outputSchema: {
                type: "object",
                properties: { sum: { type: "number" } },
                required: ["sum"],
              },
            },
            ...["fail", "protocol_error", "slow"].map((name) => ({
              name,
              description: name,
              inputSchema: { type: "object", properties: {} },
            })),
          ],
        };
      else if (message.method === "tools/call") {
        const params = z
          .record(z.string(), z.unknown())
          .parse(message.params ?? {});
        const name = String(params["name"]);
        calls.push(name);
        if (name === "sum") {
          const { a, b } = z
            .object({ a: z.number(), b: z.number() })
            .parse(params["arguments"]);
          result = {
            content: [{ type: "text", text: "raw nested payload" }],
            structuredContent: { sum: a + b },
          };
        } else if (name === "fail")
          result = {
            isError: true,
            content: [{ type: "text", text: "original tool failure" }],
          };
        else if (name === "protocol_error")
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32001,
              message: "original protocol failure",
              data: { original: true },
            },
          });
        else if (name === "slow") {
          const meta = params["_meta"];
          const token =
            typeof meta === "object" && meta !== null && "progressToken" in meta
              ? meta.progressToken
              : undefined;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                slow = controller;
                controller.enqueue(
                  new TextEncoder().encode(
                    `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: 1, message: "mcp progress" } })}\n\n`,
                  ),
                );
              },
              cancel() {
                slow = undefined;
              },
            }),
            {
              headers: {
                "content-type": "text/event-stream",
                "mcp-session-id": "fixture",
              },
            },
          );
        }
      } else result = {};
      return Response.json(
        { jsonrpc: "2.0", id: message.id, result },
        { headers: { "mcp-session-id": "fixture" } },
      );
    },
  });
  cleanups.push(async () => {
    slow?.close();
    slow = undefined;
    await server.stop(true);
  });
  return {
    config: {
      url: new URL("/mcp", server.url).href,
      headers: { Authorization: "Bearer configured" },
      description: "Remote test tools",
    },
    calls,
    cancelled: cancelled.promise,
    get deleted() {
      return deleted;
    },
  };
}

test("codemode 混合编排基础工具与 MCP，MCP 不直接暴露且嵌套输出不泄漏", async () => {
  const http = remote();
  const f = await fixture({ demo: http.config });
  f.faux.setResponses([
    (request) => {
      expect(getCurrentTools(request.messages).map(({ name }) => name)).toEqual(
        ["read", "write", "edit", "bash", "codemode"],
      );
      expect(getCurrentSystemPrompt(request.messages)).toContain("mcp__demo");
      return call("mcp__demo__sum", { a: 2, b: 3 });
    },
    (request) => {
      expect(http.calls).toHaveLength(0);
      expect(
        request.messages.findLast((message) => message.role === "toolResult")
          ?.isError,
      ).toBe(true);
      return call("codemode", {
        code: `
        const found = await searchTools("sum", { namespace: "mcp__demo" });
        text(found);
        text(await describeNamespace("mcp__demo"));
        await tools.write({ path: "mixed.txt", content: "before" });
        await tools.edit({ path: "mixed.txt", edits: [{ oldText: "before", newText: "after" }] });
        const [file, shell, result] = await Promise.all([
          tools.read({ path: "mixed.txt" }),
          tools.bash({ command: "printf mixed-shell" }),
          tools.mcp__demo__sum({ a: 2, b: 3 }),
        ]);
        text("file:" + file);
        text(shell.output);
        text("sum:" + result.sum);
      `,
      });
    },
    (request) => {
      const result = request.messages.findLast(
        (message) => message.role === "toolResult",
      );
      expect(result?.isError).toBe(false);
      const text = contentText(result?.content ?? []);
      expect(text).toContain("mcp__demo__sum");
      expect(text).toContain("Remote fixture instructions");
      expect(text).toContain("file:after");
      expect(text).toContain("mixed-shell");
      expect(text).toContain("sum:5");
      expect(JSON.stringify(request.messages)).not.toContain(
        "raw nested payload",
      );
      return fauxAssistantMessage("MCP 完成");
    },
  ]);
  expect((await f.submit("使用 MCP")).status).toBe("done");
  expect(http.calls).toEqual(["sum"]);
  await f.agent.close();
  expect(http.deleted).toBe(true);
});

test("MCP 工具失败与协议错误保留原始内容，codemode 可以捕获后继续", async () => {
  const http = remote();
  const f = await fixture({ demo: http.config });
  f.faux.setResponses([
    call("codemode", {
      code: `
      for (const name of ["mcp__demo__fail", "mcp__demo__protocol_error"]) {
        try { await tools[name]({}); } catch (error) { text(error.message); }
      }
      text("continued");
    `,
    }),
    (request) => {
      const result = request.messages.findLast(
        (message) => message.role === "toolResult",
      );
      expect(result?.isError).toBe(false);
      const text = contentText(result?.content ?? []);
      expect(text).toContain("original tool failure");
      expect(text).toContain("original protocol failure");
      expect(text).toContain("continued");
      return fauxAssistantMessage("错误已处理");
    },
  ]);
  expect((await f.submit("处理 MCP 错误")).status).toBe("done");
});

for (const action of ["abort", "reopen"]) {
  test(`MCP 进度进入原生状态，${action} 终止未完成请求且不自动重跑`, async () => {
    const http = remote();
    const f = await fixture({ demo: http.config });
    const progressed = Promise.withResolvers<void>();
    const observe = (live: Readonly<LiveState>) => {
      if (live.nestedTools?.some(({ output }) => output === "mcp progress"))
        progressed.resolve();
    };
    f.faux.setResponses([
      call("codemode", { code: "await tools.mcp__demo__slow({});" }),
    ]);
    const submission = await f.root.submit(
      { type: "input", content: "运行 MCP 长任务" },
      context,
    );
    const observation = await f.agent.harness.observeDoc(
      LiveDoc,
      f.root.id,
      {
        advance(call) {
          if (call.kind === "value") observe(call.value);
        },
        end() {},
      },
      context,
    );
    if (observation) observe(observation.value);
    try {
      await progressed.promise;
      if (action === "abort") {
        await f.root.abort(context, { background: true });
        expect(await submission.wait(context)).toMatchObject({
          status: "unanswered",
          reason: "aborted",
        });
        await http.cancelled;
      } else {
        f.faux.setResponses([
          (request) => {
            const result = request.messages.findLast(
              (message) => message.role === "toolResult",
            );
            expect(result?.toolName).toBe("codemode");
            expect(result?.isError).toBe(true);
            return fauxAssistantMessage("未重复远程调用");
          },
        ]);
        await f.reopen();
        const restored = await f.agent.harness.submission(
          submission.id,
          context,
        );
        expect(await restored?.wait(context)).toMatchObject({ status: "done" });
      }
      await f.agent.harness.waitForIdle(context);
      expect(http.calls).toEqual(["slow"]);
    } finally {
      observation?.detach();
    }
  });
}

test("stdio MCP 使用 workspace 和字面 env，关闭终止进程，重启重新连接", async () => {
  const f = await fixture({
    local: {
      command: process.execPath,
      args: [stdio],
      cwd: "workspace",
      env: { MCP_TEST_VALUE: "${NOT_EXPANDED}" },
    },
  });
  f.faux.setResponses([
    call("codemode", {
      code: 'const result = await tools.mcp__local__status({}); store("pid", result.pid); text(result);',
    }),
    fauxAssistantMessage("进程信息已读取"),
  ]);
  expect((await f.submit("读取进程信息")).status).toBe("done");
  const saved = await f.agent.harness.snapshot(
    CodemodeStoreDoc,
    f.root.id,
    context,
  );
  const pid = z.int().positive().parse(saved?.values["pid"]);
  await f.reopen();
  expect(() => process.kill(pid, 0)).toThrow();
  f.faux.setResponses([
    call("codemode", {
      code: "const result = await tools.mcp__local__status({}); text(result.cwd); text(result.value);",
    }),
    (request) => {
      const text = contentText(
        request.messages.findLast((message) => message.role === "toolResult")
          ?.content ?? [],
      );
      expect(text).toContain(f.config.workspace);
      expect(text).toContain("${NOT_EXPANDED}");
      return fauxAssistantMessage("重启后可调用");
    },
  ]);
  expect((await f.submit("重启后继续")).status).toBe("done");
});

test("禁用的 MCP 服务器不会启动或暴露工具", async () => {
  const f = await fixture({
    off: { command: "amadeus-missing-mcp-command", enabled: false },
  });
  expect(
    (await f.root.agent(context)).callable.some(({ name }) =>
      name.startsWith("mcp__"),
    ),
  ).toBe(false);
  f.faux.setResponses([fauxAssistantMessage("无需连接")]);
  expect((await f.submit("普通输入")).status).toBe("done");
});

test("启动连接失败会关闭已启动的服务器并释放目录锁", async () => {
  const http = remote(true);
  const home = await directory();
  await mkdir(join(home, "workspace"));
  const pidFile = join(home, "server.pid");
  const config = parseConfig(
    {
      ...base,
      mcpServers: {
        first: {
          command: process.execPath,
          args: [stdio],
          env: { MCP_TEST_PID_FILE: pidFile },
        },
        second: http.config,
      },
    },
    home,
  );
  const faux = fauxProvider({ provider: "openai", models: [{ id: "test" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  await expect(openAgent(config, models)).rejects.toBeInstanceOf(
    McpAuthRequiredError,
  );
  const pid = Number(await Bun.file(pidFile).text());
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow();
  await using lock = await acquireLock(home);
  expect(lock.fd).toBeGreaterThanOrEqual(0);
});

test("并发关闭等待同一清理结果，Harness 报错后仍关闭 MCP 并释放锁", async () => {
  const http = remote();
  const config = parseConfig(
    { ...base, mcpServers: { demo: http.config } },
    await directory(),
  );
  const agent = await openAgent(config, createModels());
  const close = agent.harness.close.bind(agent.harness);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const failure = { message: "original close failure", stage: "harness" };
  const closing = spyOn(agent.harness, "close").mockImplementation(
    async (context) => {
      started.resolve();
      await release.promise;
      await close(context);
      throw failure;
    },
  );
  const first = agent.close();
  const result = first.catch((error: unknown) => error);
  try {
    await started.promise;
    expect(agent.close()).toBe(first);
    expect(http.deleted).toBe(false);
    await expect(acquireLock(config.stateDirectory)).rejects.toMatchObject({
      exitCode: 1,
      success: false,
    });
  } finally {
    release.resolve();
    try {
      expect(await result).toBe(failure);
    } finally {
      closing.mockRestore();
    }
  }
  expect(http.deleted).toBe(true);
  await using lock = await acquireLock(config.stateDirectory);
  expect(lock.fd).toBeGreaterThanOrEqual(0);
});
