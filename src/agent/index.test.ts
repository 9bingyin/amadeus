import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { contentText } from "@earendil-works/pi-ai/utils/text";
import {
  LiveDoc,
  type Conversation,
  type LiveState,
} from "@earendil-works/pi-durable";
import { CodemodeStoreDoc } from "@earendil-works/pi-durable/codemode";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAgent, type Agent } from ".";
import { parseConfig } from "../config";

const context = BACKGROUND_CONTEXT;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(workspace = "workspace") {
  const directory = await mkdtemp(join(tmpdir(), "amadeus-tools-test-"));
  const config = parseConfig(
    {
      channels: { telegram: { token: "123:TEST", allowedUserIds: [1] } },
      agent: { model: { provider: "openai", modelId: "test" } },
      providers: { openai: { apiKey: "test-key" } },
      workspace,
    },
    directory,
  );
  const faux = fauxProvider({
    provider: "openai",
    models: [{ id: "test", input: ["text", "image"] }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  let agent: Agent;
  let root: Conversation;
  async function open() {
    agent = await openAgent(config, models);
    root = await agent.harness.root(context, { agent: agent.configuration });
    agent.harness.resume();
  }
  cleanups.push(async () => {
    try {
      await agent?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await open();
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
      await open();
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

function call(name: string, args: Parameters<typeof fauxToolCall>[1]) {
  return fauxAssistantMessage(fauxToolCall(name, args), {
    stopReason: "toolUse",
  });
}

test("官方四种工具使用 workspace，重启保留文件和工具注册", async () => {
  const f = await fixture("custom/workspace");
  expect((await stat(f.config.workspace)).mode & 0o777).toBe(0o700);
  expect((await f.root.agent(context)).cwd).toBe(f.config.workspace);
  f.faux.setResponses([
    (request) => {
      expect(getCurrentTools(request.messages).map(({ name }) => name)).toEqual(
        ["read", "write", "edit", "bash", "codemode"],
      );
      return call("write", { path: "notes.txt", content: "hello world\n" });
    },
    call("edit", {
      path: "notes.txt",
      edits: [{ oldText: "world", newText: "durable" }],
    }),
    call("read", { path: "notes.txt" }),
    (request) => {
      const result = request.messages.findLast(
        (message) => message.role === "toolResult",
      );
      expect(result?.isError).toBe(false);
      expect(contentText(result?.content ?? [])).toBe("hello durable\n");
      return call("bash", {
        command:
          "printf '%s\\n' \"$PWD\"; printf 'native failure\\n' >&2; exit 7",
      });
    },
    (request) => {
      const result = request.messages.findLast(
        (message) => message.role === "toolResult",
      );
      expect(result?.isError).toBe(true);
      expect(contentText(result?.content ?? [])).toContain(f.config.workspace);
      expect(contentText(result?.content ?? [])).toContain("native failure");
      return fauxAssistantMessage("工具完成");
    },
  ]);
  expect((await f.submit("创建、编辑、读取文件并运行命令")).status).toBe(
    "done",
  );
  const path = join(f.config.workspace, "notes.txt");
  expect(await Bun.file(path).text()).toBe("hello durable\n");
  await Bun.write(path, "external change\n");
  await f.reopen();
  f.faux.setResponses([
    call("read", { path: "notes.txt" }),
    (request) => {
      const result = request.messages.findLast(
        (message) => message.role === "toolResult",
      );
      expect(contentText(result?.content ?? [])).toBe("external change\n");
      return fauxAssistantMessage("恢复完成");
    },
  ]);
  expect((await f.submit("继续读取")).status).toBe("done");
  expect(f.faux.state.callCount).toBe(7);
});

test("codemode 原生编排基础工具，只向模型返回脚本输出，状态跨重启保留", async () => {
  const f = await fixture();
  const privatePayload = "nested-only-payload".repeat(200);
  await Bun.write(join(f.config.workspace, "private.txt"), privatePayload);
  f.faux.setResponses([
    call("codemode", {
      code: `
      const [source, shell] = await Promise.all([
        tools.read({ path: "private.txt" }),
        tools.bash({ command: "printf 'shell-output'; exit 7" }),
      ]);
      await tools.write({ path: "summary.txt", content: String(source.length) });
      await tools.edit({ path: "summary.txt", edits: [{ oldText: String(source.length), newText: "filtered" }] });
      store("summary", { length: source.length, exitCode: shell.exitCode });
      text(shell.output);
      text(await tools.read({ path: "summary.txt" }));
    `,
    }),
    (request) => {
      expect(getCurrentSystemPrompt(request.messages)).toContain("<codemode>");
      const results = request.messages.filter(
        (message) => message.role === "toolResult",
      );
      expect(results).toHaveLength(1);
      expect(results[0]?.toolName).toBe("codemode");
      expect(results[0]?.isError).toBe(false);
      const output = contentText(results[0]?.content ?? []);
      expect(output).toContain("shell-output");
      expect(output).toContain("filtered");
      expect(JSON.stringify(request.messages)).not.toContain(privatePayload);
      return fauxAssistantMessage("编排完成");
    },
  ]);
  expect((await f.submit("批量处理数据")).status).toBe("done");
  expect(
    (await f.agent.harness.snapshot(CodemodeStoreDoc, f.root.id, context))
      ?.values["summary"],
  ).toEqual({
    length: privatePayload.length,
    exitCode: 7,
  });
  await f.reopen();
  f.faux.setResponses([
    call("codemode", { code: 'text("restored:" + load("summary").length);' }),
    (request) => {
      const result = request.messages.findLast(
        (message) => message.role === "toolResult",
      );
      expect(result?.isError).toBe(false);
      expect(contentText(result?.content ?? [])).toContain(
        `restored:${privatePayload.length}`,
      );
      return fauxAssistantMessage("状态已恢复");
    },
  ]);
  expect((await f.submit("读取保存的状态")).status).toBe("done");
  expect(f.faux.state.callCount).toBe(4);
});

test("codemode 保留脚本异常和已产生的输出，不提交失败脚本的 store 写入", async () => {
  const f = await fixture();
  f.faux.setResponses([
    call("codemode", {
      code: 'store("failed", true); text("before failure"); throw new TypeError("codemode original");',
    }),
    (request) => {
      const result = request.messages.findLast(
        (message) => message.role === "toolResult",
      );
      expect(result?.isError).toBe(true);
      const output = contentText(result?.content ?? []);
      expect(output).toContain("before failure");
      expect(output).toContain("codemode original");
      return fauxAssistantMessage("原始异常已收到");
    },
  ]);
  expect((await f.submit("运行有异常的脚本")).status).toBe("done");
  expect(
    (await f.agent.harness.snapshot(CodemodeStoreDoc, f.root.id, context))
      ?.values["failed"],
  ).toBeUndefined();
});

for (const tool of ["read", "codemode"]) {
  test(`${tool} 通过官方 Photon 转换 BMP 并返回模型图片块`, async () => {
    const f = await fixture();
    const bmp = Buffer.alloc(58);
    bmp.write("BM");
    bmp.writeUInt32LE(58, 2);
    bmp.writeUInt32LE(54, 10);
    bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(1, 18);
    bmp.writeInt32LE(1, 22);
    bmp.writeUInt16LE(1, 26);
    bmp.writeUInt16LE(24, 28);
    bmp[56] = 255;
    await Bun.write(join(f.config.workspace, "image.bmp"), bmp);
    f.faux.setResponses([
      call(
        tool,
        tool === "read"
          ? { path: "image.bmp" }
          : { code: 'image(await tools.read({ path: "image.bmp" }));' },
      ),
      (request) => {
        const result = request.messages.findLast(
          (message) => message.role === "toolResult",
        );
        expect(result?.isError).toBe(false);
        const image = result?.content.find((part) => part.type === "image");
        expect(image?.mimeType).toBe("image/png");
        expect(image?.data.length).toBeGreaterThan(0);
        return fauxAssistantMessage("图片已读取");
      },
    ]);
    expect((await f.submit("读取图片")).status).toBe("done");
  });
}

for (const tool of ["bash", "codemode"]) {
  for (const action of ["abort", "reopen"]) {
    test(`${tool} 在 ${action} 时终止进程，未完成命令不自动重跑`, async () => {
      const f = await fixture();
      const started = Promise.withResolvers<number>();
      const observe = (live: Readonly<LiveState>) => {
        const output = [
          ...(live.tools ?? []),
          ...(live.nestedTools ?? []),
        ].find(({ name }) => name === "bash")?.output;
        const pid = Number(output?.trim());
        if (Number.isSafeInteger(pid) && pid > 0) started.resolve(pid);
      };
      const command =
        "printf 'started\\n' >> invocations.log; printf '%s\\n' \"$$\"; exec sleep 60";
      f.faux.setResponses([
        call(
          tool,
          tool === "bash"
            ? { command }
            : {
                code: `await tools.write({ path: "completed.txt", content: "first" }); await tools.bash(${JSON.stringify({ command })});`,
              },
        ),
      ]);
      const submission = await f.root.submit(
        { type: "input", content: "运行长命令" },
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
        const pid = await started.promise;
        if (tool === "codemode")
          await Bun.write(
            join(f.config.workspace, "completed.txt"),
            "external change",
          );
        if (action === "abort") {
          await f.root.abort(context, { background: true });
          expect(await submission.wait(context)).toMatchObject({
            status: "unanswered",
            reason: "aborted",
          });
        } else {
          f.faux.setResponses([
            (request) => {
              const result = request.messages.findLast(
                (message) => message.role === "toolResult",
              );
              expect(result?.toolName).toBe(tool);
              expect(result?.isError).toBe(true);
              return fauxAssistantMessage("命令未重跑");
            },
          ]);
          await f.reopen();
          const restored = await f.agent.harness.submission(
            submission.id,
            context,
          );
          expect(await restored?.wait(context)).toMatchObject({
            status: "done",
          });
        }
        await f.agent.harness.waitForIdle(context);
        expect(() => process.kill(pid, 0)).toThrow();
        expect(
          await Bun.file(join(f.config.workspace, "invocations.log")).text(),
        ).toBe("started\n");
        if (tool === "codemode")
          expect(
            await Bun.file(join(f.config.workspace, "completed.txt")).text(),
          ).toBe("external change");
      } finally {
        observation?.detach();
      }
    });
  }
}
