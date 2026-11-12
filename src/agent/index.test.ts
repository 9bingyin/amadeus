import { afterEach, expect, spyOn, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  getCurrentSystemPrompt,
  getCurrentTools,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { contentText } from "@earendil-works/pi-ai/utils/text";
import {
  defineExtension,
  LiveDoc,
  section,
  type Conversation,
  type LiveState,
} from "@earendil-works/pi-durable";
import { CodemodeStoreDoc } from "@earendil-works/pi-durable/codemode";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { arch, platform, release, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ZodError } from "zod";
import { openAgent, type Agent } from ".";
import { parseConfig } from "../config";
import { openIpc } from "../channels/ipc";
import { NotificationEntry } from "../channels/notifications";
import type { Channel } from "../channels";

const context = BACKGROUND_CONTEXT;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(workspace = "workspace", ipcEnabled = false) {
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
  let ipc: Channel | undefined;
  async function open() {
    agent = await openAgent(config, models);
    try {
      if (ipcEnabled) ipc = await openIpc(agent);
      root = await agent.harness.root(context, { agent: agent.configuration });
      agent.harness.resume();
    } catch (error) {
      await agent.close();
      throw error;
    }
  }
  async function close() {
    await ipc?.run(AbortSignal.abort());
    await agent?.close();
  }
  cleanups.push(async () => {
    try {
      await close();
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
    close,
    async reopen() {
      await close();
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

test("原生 bash 注入独立 IPC 凭据，显式通知去重并触发后续运行", async () => {
  const f = await fixture("work space", true);
  f.faux.setResponses([
    (request) => {
      expect(getCurrentSystemPrompt(request.messages)).toContain(
        "AMADEUS_NOTIFY_CLI",
      );
      return call("bash", {
        command:
          'bun run "$AMADEUS_NOTIFY_CLI" --key release --message "版本发生变化" --data \'{"version":"1.3"}\'; bun run "$AMADEUS_NOTIFY_CLI" --key release --message "版本发生变化" --data \'{"version":"1.3"}\'',
      });
    },
    (request) => {
      const output = contentText(
        request.messages.findLast((message) => message.role === "toolResult")
          ?.content ?? [],
      );
      expect(output).toContain('"status":"accepted"');
      expect(output).toContain('"status":"duplicate"');
      expect(output).not.toContain("AMADEUS_NOTIFY_TOKEN");
      return fauxAssistantMessage("命令执行完成");
    },
    (request) => {
      const input = request.messages.findLast(
        (message) => message.role === "user",
      );
      expect(contentText(input?.content ?? [])).toContain("版本发生变化");
      return fauxAssistantMessage("检测到新版本，需要确认是否升级。");
    },
  ]);
  await f.submit("执行检查");
  const history = await f.root.entries({}, 100, undefined, context);
  expect(history.items.filter(NotificationEntry.is)).toHaveLength(1);
  expect(f.faux.state.callCount).toBe(3);
});

test("codemode 内嵌原生 bash 也能通知，普通 stdout 不自动提交", async () => {
  const f = await fixture("workspace", true);
  f.faux.setResponses([
    call("codemode", {
      code: 'const result = await tools.bash({command: \'printf "ordinary output\\n"; bun run "$AMADEUS_NOTIFY_CLI" --key nested --message "需要后续处理"\'}); text(result.exitCode);',
    }),
    fauxAssistantMessage("后台结果已登记"),
    (request) => {
      const input = request.messages.findLast(
        (message) => message.role === "user",
      );
      expect(contentText(input?.content ?? [])).toContain("需要后续处理");
      expect(contentText(input?.content ?? [])).not.toContain(
        "ordinary output",
      );
      return fauxAssistantMessage("已处理通知");
    },
  ]);
  await f.submit("运行脚本");
  expect(
    (await f.root.entries({}, 100, undefined, context)).items.filter(
      NotificationEntry.is,
    ),
  ).toHaveLength(1);
  expect(f.faux.state.callCount).toBe(3);
});

test("codemode 使用单一 schedule 创建、查询和直接删除活动计划", async () => {
  const f = await fixture();
  f.faux.setResponses([
    call("codemode", {
      code: `
      const created = await tools.schedule({action:"create",name:"check",command:"printf report",when:{kind:"after",delayMs:3600000}});
      const status = await tools.schedule({action:"list",id:created.id});
      text({name:status.schedules[0].name, state:status.schedules[0].state.status});
      text(await tools.schedule({action:"delete",id:created.id}));
      text(await tools.schedule({action:"list"}));
    `,
    }),
    (request) => {
      const result = request.messages.findLast(
        (message) => message.role === "toolResult",
      );
      expect(result?.isError).toBe(false);
      expect(contentText(result?.content ?? [])).toContain('"name":"check"');
      expect(contentText(result?.content ?? [])).toContain('"deleted":true');
      expect(contentText(result?.content ?? [])).toContain('"schedules":[]');
      expect(getCurrentSystemPrompt(request.messages)).toContain(
        "stdout is a report",
      );
      return fauxAssistantMessage("定时任务已清理");
    },
  ]);
  expect((await f.submit("管理定时脚本")).status).toBe("done");
});

test("定时 Worker 可用原生 codemode，但不能管理计划、调用完成工具嵌套入口或获取 IPC 凭据", async () => {
  const f = await fixture("workspace", true);
  let workerCalls = 0;
  f.faux.setResponses(
    Array.from({ length: 8 }, () => (request) => {
      if (
        getCurrentSystemPrompt(request.messages).includes("<scheduled_worker>")
      ) {
        const prompt = getCurrentSystemPrompt(request.messages);
        expect(prompt).not.toContain("<ipc>");
        expect(prompt).not.toContain("<notifications>");
        expect(
          getCurrentTools(request.messages).map(({ name }) => name),
        ).not.toContain("schedule");
        if (workerCalls++ === 0)
          return call("codemode", {
            code: `
        let scheduleBlocked=false, finishBlocked=false;
        try { await tools.schedule({action:"list"}); } catch { scheduleBlocked=true; }
        try { await tools.schedule_result({notify:false}); } catch { finishBlocked=true; }
        text([scheduleBlocked,finishBlocked]);
        const result=await tools.bash({command:"bun -e 'console.log(JSON.stringify([process.env.AMADEUS_NOTIFY_SOCKET,process.env.AMADEUS_NOTIFY_TOKEN,process.env.AMADEUS_NOTIFY_CLI]))'"});
        text(result.output);
      `,
          });
        const result = request.messages.findLast(
          (message) => message.role === "toolResult",
        );
        expect(result?.isError).toBe(false);
        expect(contentText(result?.content ?? [])).toContain("[true,true]");
        expect(contentText(result?.content ?? [])).toContain(
          "[null,null,null]",
        );
        return fauxAssistantMessage("权限检查完成，无需报告。");
      }
      const last = request.messages.findLast(
        (message) => message.role !== "system",
      );
      if (last?.role === "toolResult") return fauxAssistantMessage("已安排");
      return call("schedule", {
        action: "create",
        name: "worker",
        prompt: "检查工具权限并静默完成",
        when: { kind: "after", delayMs: 0 },
      });
    }),
  );
  expect((await f.submit("启动定时 Worker")).status).toBe("done");
  const plans = await f.agent.harness.commit(
    (tx) => tx.scanTasks({ kind: "amadeus.schedule" }, 100),
    context,
  );
  for (const task of plans.items)
    await f.agent.harness.waitForTask(task.id, context);
  expect(f.faux.state.callCount).toBe(4);
  expect(
    (await f.root.entries({}, 100, undefined, context)).items.filter(
      NotificationEntry.is,
    ),
  ).toHaveLength(0);
});

test("IPC 接入拒绝覆盖已有文件，启动方保留原错误并释放目录锁", async () => {
  const f = await fixture("workspace", true);
  await f.close();
  const socket = join(f.config.stateDirectory, "ipc", "notify.sock");
  await Bun.write(socket, "preserve existing data");
  await expect(f.reopen()).rejects.toBeInstanceOf(ZodError);
  expect(await Bun.file(socket).text()).toBe("preserve existing data");
  await rm(socket);
  await f.reopen();
  f.faux.setResponses([fauxAssistantMessage("启动已恢复")]);
  expect((await f.submit("继续")).status).toBe("done");
});

test("memory_create 与原生文件工具维护记忆，目录在下一请求更新且不预载正文", async () => {
  const f = await fixture();
  const path = join(
    f.config.stateDirectory,
    "memory",
    "topics",
    "preferences.md",
  );
  const index = join(f.config.stateDirectory, "memory", "MEMORY.md");
  f.faux.setResponses([
    (request) => {
      const prompt = getCurrentSystemPrompt(request.messages);
      expect(prompt).toContain("No topics yet.");
      expect(prompt).toContain("Update topic files to change this catalog.");
      return call("memory_create", {
        name: "preferences",
        title: "Reply preferences",
        summary: "Concise replies",
        content: "Memory body is loaded on demand.\n",
      });
    },
    (request) => {
      const prompt = getCurrentSystemPrompt(request.messages);
      expect(prompt).toContain("Reply preferences");
      expect(prompt).toContain("Concise replies");
      expect(prompt).not.toContain("Memory body is loaded on demand.");
      return call("read", { path });
    },
    (request) => {
      const result = request.messages.findLast(
        (message) => message.role === "toolResult",
      );
      expect(contentText(result?.content ?? [])).toContain(
        "Memory body is loaded on demand.",
      );
      return call("edit", {
        path,
        edits: [
          {
            oldText: "summary: Concise replies",
            newText: "summary: Detailed replies",
          },
          {
            oldText: "Memory body is loaded on demand.",
            newText: "Updated private memory body.",
          },
        ],
      });
    },
    (request) => {
      const prompt = getCurrentSystemPrompt(request.messages);
      expect(prompt).toContain("Detailed replies");
      expect(prompt).not.toContain("Concise replies");
      expect(prompt).not.toContain("Updated private memory body.");
      return call("bash", { command: `rm -- ${JSON.stringify(path)}` });
    },
    (request) => {
      const prompt = getCurrentSystemPrompt(request.messages);
      expect(prompt).toContain("No topics yet.");
      expect(prompt).not.toContain("Reply preferences");
      return fauxAssistantMessage("已移除长期笔记");
    },
  ]);
  expect((await f.submit("保存、读取、纠正并忘记这条记忆")).status).toBe(
    "done",
  );
  expect(await Bun.file(path).exists()).toBe(false);
  expect(await Bun.file(index).text()).toContain("No topics yet.");
});

test("codemode 可调用 memory_create 并用原生 read 读取结构化回执中的文件", async () => {
  const f = await fixture();
  f.faux.setResponses([
    call("codemode", {
      code: `
      const saved = await tools.memory_create({
        name: "via_script", title: "Script topic", summary: "Created with codemode", content: "script-private-body"
      });
      const body = await tools.read({ path: saved.path });
      text({ path: saved.path, hasBody: body.includes("script-private-body") });
    `,
    }),
    (request) => {
      const result = request.messages.findLast(
        (message) => message.role === "toolResult",
      );
      expect(result?.toolName).toBe("codemode");
      expect(result?.isError).toBe(false);
      expect(contentText(result?.content ?? [])).toContain('"hasBody":true');
      const prompt = getCurrentSystemPrompt(request.messages);
      expect(prompt).toContain("Created with codemode");
      expect(prompt).not.toContain("script-private-body");
      return fauxAssistantMessage("主题已创建");
    },
  ]);
  expect((await f.submit("通过脚本创建记忆")).status).toBe("done");
});

test("记忆随应用 HOME 跨重启和 reset 保留，不随原生 cwd 改变或扫描 workspace", async () => {
  const f = await fixture();
  const root = join(f.config.stateDirectory, "memory");
  const file = join(root, "topics", "project.md");
  await Bun.write(
    file,
    "---\ntitle: Durable topic\nsummary: Confirmed decision\n---\n\nprivate-persistent-body\n",
  );
  const ignored = join(f.config.workspace, "memory", "topics");
  await mkdir(ignored, { recursive: true });
  await Bun.write(join(ignored, "wrong.md"), "workspace-memory-must-not-load");
  await f.reopen();
  await f.root.reset(undefined, context);
  const cwd = join(f.config.workspace, "nested");
  await mkdir(cwd);
  await f.root.configure({ cwd }, context);
  f.faux.setResponses([
    (request) => {
      const prompt = getCurrentSystemPrompt(request.messages);
      expect(prompt).toContain(
        `Long-term memory root: ${JSON.stringify(root)}`,
      );
      expect(prompt).toContain("Confirmed decision");
      expect(prompt).not.toContain("private-persistent-body");
      expect(prompt).not.toContain("workspace-memory-must-not-load");
      expect(prompt).toContain(`<cwd>\n${cwd}\n</cwd>`);
      return fauxAssistantMessage("目录保持不变");
    },
  ]);
  expect((await f.submit("读取长期记忆目录")).status).toBe("done");
  expect(await Bun.file(file).text()).toContain("private-persistent-body");
});

test("记忆元数据启动错误保持原始 ZodError 并释放存储和目录锁", async () => {
  const f = await fixture();
  const file = join(f.config.stateDirectory, "memory", "topics", "broken.md");
  await Bun.write(file, "---\ntitle: Missing summary\n---\nbody");
  await expect(f.reopen()).rejects.toBeInstanceOf(ZodError);
  await rm(file);
  await f.reopen();
  f.faux.setResponses([fauxAssistantMessage("修正后可再次启动")]);
  expect((await f.submit("继续")).status).toBe("done");
});

test("历史工具随 Agent 安装，重启和 reset 后可通过 codemode 搜索并读取旧消息", async () => {
  const f = await fixture();
  f.faux.setResponses([fauxAssistantMessage("已记住")]);
  await f.submit("启动集成：数据库迁移方案");
  await f.reopen();
  await f.root.reset(undefined, context);
  f.faux.setResponses([
    call("codemode", {
      code: `
        const found = await tools.session_search({ query: "启动集成" });
        const read = await tools.session_read({ fromEntryId: found.matches[0].entryId, limit: 1 });
        text({ matches: found.matches.length, text: read.messages[0].text });
      `,
    }),
    (request) => {
      const names = getCurrentTools(request.messages).map(({ name }) => name);
      expect(names).toContain("session_read");
      expect(names).toContain("session_search");
      const result = request.messages.findLast(
        (message) => message.role === "toolResult",
      );
      expect(result?.isError).toBe(false);
      expect(contentText(result?.content ?? [])).toContain('"matches":1');
      expect(contentText(result?.content ?? [])).toContain(
        "启动集成：数据库迁移方案",
      );
      return fauxAssistantMessage("历史已恢复");
    },
  ]);
  expect((await f.submit("查阅之前的历史")).status).toBe("done");
});

test("system prompt 由原生 section 组装，重启配置清除旧 instructions，cwd 随会话更新", async () => {
  const f = await fixture();
  let shownSystem: string | undefined;
  function response(cwd: string) {
    return (request: TranscriptContext) => {
      const prompt = getCurrentSystemPrompt(request.messages);
      expect(
        prompt.startsWith(
          "You are a personal assistant inside pi durable, an agent harness.",
        ),
      ).toBe(true);
      expect(prompt).toContain(
        "<rules>\n- Use bash for file operations like ls, rg, find",
      );
      expect(prompt).toContain(
        "Use edit for targeted changes. Batch changes to one file in a single call.",
      );
      expect(prompt).not.toContain("<docs>");
      expect(prompt).not.toContain("Pi documentation");
      const system = prompt.split("<system>\n")[1]?.split("\n</system>")[0];
      expect(system).toContain(`${platform()} ${release()} ${arch()}`);
      expect(system).toContain(
        `Timezone: ${new Intl.DateTimeFormat().resolvedOptions().timeZone}`,
      );
      expect(system).toMatch(/\(GMT(?:[+-]\d{2}:\d{2})?\)/);
      if (shownSystem !== undefined) expect(system).toBe(shownSystem);
      else shownSystem = system;
      expect(prompt).toContain("<platform>\n<ipc>");
      expect(prompt).not.toContain("<telegram>");
      expect(prompt).not.toContain("<notifications>");
      expect(prompt).not.toContain('bun run "$AMADEUS_NOTIFY_CLI"');
      expect(prompt).toContain(`<cwd>\n${cwd}\n</cwd>`);
      expect(prompt).toContain("<codemode>");
      expect(prompt).not.toContain("<instructions>");
      expect(prompt).not.toContain("legacy-configured-instructions");
      expect(prompt).not.toContain("你是 Amadeus");
      expect(getCurrentTools(request.messages).map(({ name }) => name)).toEqual(
        [
          "memory_create",
          "read",
          "write",
          "edit",
          "bash",
          "session_read",
          "session_search",
          "schedule",
          "codemode",
        ],
      );
      return fauxAssistantMessage("固定提示正常");
    };
  }
  f.faux.setResponses([response(f.config.workspace)]);
  expect((await f.submit("检查固定提示")).status).toBe("done");
  await f.root.configure(
    { instructions: "legacy-configured-instructions" },
    context,
  );
  await f.reopen();
  await f.root.configure(f.agent.configuration, context);
  expect((await f.root.agent(context)).instructions).toBeUndefined();
  const cwd = join(f.config.workspace, "nested");
  await mkdir(cwd);
  await f.root.configure({ cwd }, context);
  f.faux.setResponses([response(cwd)]);
  expect((await f.submit("重启后继续")).status).toBe("done");
});

test("HOME 的 SOUL.md 定义身份，重启更新或清空后原生替换身份并移除旧 docs", async () => {
  const f = await fixture();
  f.agent.registry.install(
    defineExtension({
      name: "amadeus.system-prompt",
      sections: [
        section(
          "preamble",
          () => "You are a coding assistant running inside pi.",
          { tag: false },
        ),
        section("docs", () => "Pi documentation: old bundled docs"),
      ],
    }),
  );
  f.faux.setResponses([
    (request) => {
      expect(getCurrentSystemPrompt(request.messages)).toContain(
        "<docs>\nPi documentation",
      );
      return fauxAssistantMessage("旧提示已保存");
    },
  ]);
  expect((await f.submit("旧版提示")).status).toBe("done");
  const path = join(f.config.stateDirectory, "SOUL.md");
  await Bun.write(
    join(f.config.workspace, "SOUL.md"),
    "workspace-identity-must-not-load",
  );
  for (const text of [
    "  你是 Amadeus，优先给出结论。\n保留内部换行。\n",
    "你是 Amadeus，新的身份定义。",
    "  \n\t",
  ]) {
    await Bun.write(path, text);
    await f.reopen();
    const identity =
      text.trim() ||
      "You are a personal assistant inside pi durable, an agent harness.";
    f.faux.setResponses([
      (request) => {
        const prompt = getCurrentSystemPrompt(request.messages);
        expect(prompt.startsWith(identity + "\n")).toBe(true);
        expect(prompt).not.toContain("workspace-identity-must-not-load");
        expect(prompt).not.toContain(
          "You are a coding assistant running inside pi",
        );
        expect(prompt).not.toContain("<docs>");
        expect(prompt).not.toContain("Pi documentation");
        expect(prompt).toContain("<rules>");
        if (!text.includes("保留内部换行"))
          expect(prompt).not.toContain("保留内部换行");
        if (!text.trim()) expect(prompt).not.toContain("新的身份定义");
        return fauxAssistantMessage("身份已更新");
      },
    ]);
    expect((await f.submit("确认身份")).status).toBe("done");
  }
});

for (const file of ["SOUL.md", "USER.md"]) {
  test(`${file} 非缺失读取错误原样抛出，启动失败释放目录锁`, async () => {
    const f = await fixture();
    const path = join(f.config.stateDirectory, file);
    await mkdir(path);
    await expect(f.reopen()).rejects.toMatchObject({ code: "EISDIR", path });
    await rm(path, { recursive: true });
    await f.reopen();
    f.faux.setResponses([fauxAssistantMessage("可再次启动")]);
    expect((await f.submit("继续")).status).toBe("done");
  });
}

test("AGENTS 使用官方全局和项目上下文发现，USER 只从应用 HOME 加载，重启原生更新及移除", async () => {
  const f = await fixture("project/nested");
  const global = join(f.config.stateDirectory, "AGENTS.md");
  const parent = join(dirname(f.config.workspace), "AGENTS.md");
  const project = join(f.config.workspace, "AGENTS.md");
  const user = join(f.config.stateDirectory, "USER.md");
  await Bun.write(global, "global-guidance-only\n");
  await Bun.write(parent, "parent-guidance-only\n");
  await Bun.write(project, "project-guidance-only\n");
  await Bun.write(user, "  user-profile-only\nPrefers concise answers.\n");
  await Bun.write(
    join(f.config.workspace, "USER.md"),
    "workspace-user-must-not-load",
  );
  await f.reopen();
  f.faux.setResponses([
    (request) => {
      const prompt = getCurrentSystemPrompt(request.messages);
      expect(prompt).toContain(
        `<project_context>\n<project_instructions path="${global}">\nglobal-guidance-only\n`,
      );
      expect(prompt).toContain(
        `<project_instructions path="${parent}">\nparent-guidance-only\n`,
      );
      expect(prompt).toContain(
        `<project_instructions path="${project}">\nproject-guidance-only\n`,
      );
      expect(prompt.indexOf("global-guidance-only")).toBeLessThan(
        prompt.indexOf("parent-guidance-only"),
      );
      expect(prompt.indexOf("parent-guidance-only")).toBeLessThan(
        prompt.indexOf("project-guidance-only"),
      );
      expect(prompt).toContain(
        "<user>\nuser-profile-only\nPrefers concise answers.\n</user>",
      );
      expect(prompt).not.toContain("workspace-user-must-not-load");
      expect(prompt).not.toContain("<docs>");
      return fauxAssistantMessage("上下文已加载");
    },
  ]);
  expect((await f.submit("检查上下文")).status).toBe("done");
  await Bun.write(global, "updated-global-guidance\n");
  await Bun.write(project, "  \n\t");
  await rm(parent);
  await rm(user);
  await f.reopen();
  f.faux.setResponses([
    (request) => {
      const prompt = getCurrentSystemPrompt(request.messages);
      expect(prompt).toContain("updated-global-guidance");
      for (const old of [
        "global-guidance-only",
        "parent-guidance-only",
        "project-guidance-only",
        "user-profile-only",
        "workspace-user-must-not-load",
      ])
        expect(prompt).not.toContain(old);
      expect(prompt).not.toContain("<user>");
      expect(prompt).not.toContain(`<project_instructions path="${project}">`);
      return fauxAssistantMessage("上下文已更新");
    },
  ]);
  expect((await f.submit("重新检查")).status).toBe("done");
});

test("HOME 与 workspace 相同时 AGENTS 由官方加载器去重，空 USER 不注入", async () => {
  const f = await fixture(".");
  const path = join(f.config.stateDirectory, "AGENTS.md");
  await Bun.write(path, "shared-context-only\n");
  await Bun.write(join(f.config.stateDirectory, "USER.md"), "  \n\t");
  await f.reopen();
  f.faux.setResponses([
    (request) => {
      const prompt = getCurrentSystemPrompt(request.messages);
      expect(prompt.match(/shared-context-only/g)).toHaveLength(1);
      expect(prompt).not.toContain("<user>");
      return fauxAssistantMessage("没有重复上下文");
    },
  ]);
  expect((await f.submit("检查去重")).status).toBe("done");
});

test("默认 skills 目录通过原生 section 提供目录，完整指令和配套脚本按需读取执行", async () => {
  const f = await fixture();
  f.faux.setResponses([
    (request) => {
      expect(getCurrentSystemPrompt(request.messages)).not.toContain(
        "<available_skills>",
      );
      return fauxAssistantMessage("无技能目录也可运行");
    },
  ]);
  expect((await f.submit("开始")).status).toBe("done");
  const skillFile = join(
    f.config.stateDirectory,
    "skills",
    "report-tools",
    "SKILL.md",
  );
  const projectFile = join(
    f.config.workspace,
    ".pi",
    "skills",
    "project-tools",
    "SKILL.md",
  );
  const hiddenFile = join(
    f.config.stateDirectory,
    "skills",
    "hidden-helper",
    "SKILL.md",
  );
  const script = join(dirname(skillFile), "scripts", "check.sh");
  const body =
    "skill-body-only: Run scripts/check.sh relative to this skill directory.";
  for (const [path, content] of [
    [
      skillFile,
      `---\nname: report-tools\ndescription: Generate reports using bundled scripts.\n---\n\n${body}\n`,
    ],
    [
      projectFile,
      "---\nname: project-tools\ndescription: Project-specific coding workflow.\n---\n\nproject-body-only\n",
    ],
    [
      hiddenFile,
      "---\nname: hidden-helper\ndescription: Hidden from automatic model selection.\ndisable-model-invocation: true\n---\n\nhidden-body-only\n",
    ],
    [script, "printf 'bundled-script-ok'\n"],
  ] as const) {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, content);
  }
  await f.reopen();
  f.faux.setResponses([
    (request) => {
      const prompt = getCurrentSystemPrompt(request.messages);
      expect(prompt).toContain("<available_skills>");
      expect(prompt).toContain("Generate reports using bundled scripts.");
      expect(prompt).toContain(skillFile);
      expect(prompt).toContain(projectFile);
      expect(prompt).not.toContain(body);
      expect(prompt).not.toContain("project-body-only");
      expect(prompt).not.toContain("hidden-helper");
      expect(prompt).toContain(
        "Resolve relative paths against the skill's directory",
      );
      expect(getCurrentTools(request.messages).map(({ name }) => name)).toEqual(
        [
          "memory_create",
          "read",
          "write",
          "edit",
          "bash",
          "session_read",
          "session_search",
          "schedule",
          "codemode",
        ],
      );
      return call("read", { path: skillFile });
    },
    (request) => {
      const result = request.messages.findLast(
        (message) => message.role === "toolResult",
      );
      expect(result?.isError).toBe(false);
      expect(contentText(result?.content ?? [])).toContain(body);
      expect(getCurrentSystemPrompt(request.messages)).not.toContain(body);
      return call("bash", {
        command: `cd ${JSON.stringify(dirname(skillFile))} && bash scripts/check.sh`,
      });
    },
    (request) => {
      const result = request.messages.findLast(
        (message) => message.role === "toolResult",
      );
      expect(result?.isError).toBe(false);
      expect(contentText(result?.content ?? [])).toContain("bundled-script-ok");
      return fauxAssistantMessage("按技能完成");
    },
  ]);
  expect((await f.submit("生成报告")).status).toBe("done");
});

test("默认 skills 目录在重启后重新扫描元数据并使用原生提示更新", async () => {
  const f = await fixture();
  const file = join(
    f.config.stateDirectory,
    "skills",
    "reload-tools",
    "SKILL.md",
  );
  await mkdir(dirname(file), { recursive: true });
  for (const description of [
    "Initial skill description.",
    "Updated skill description.",
  ]) {
    await Bun.write(
      file,
      `---\nname: reload-tools\ndescription: ${description}\n---\n\nreload-body-only\n`,
    );
    await f.reopen();
    f.faux.setResponses([
      (request) => {
        const prompt = getCurrentSystemPrompt(request.messages);
        expect(prompt).toContain(file);
        expect(prompt).toContain(description);
        expect(prompt.match(/<name>reload-tools<\/name>/g)).toHaveLength(1);
        if (description.startsWith("Updated"))
          expect(prompt).not.toContain("Initial skill description.");
        expect(prompt).not.toContain("reload-body-only");
        return fauxAssistantMessage("已刷新技能");
      },
    ]);
    expect((await f.submit("检查可用技能")).status).toBe("done");
  }
});

test("skills 扫描诊断保持官方原始对象，不影响 Agent 启动和生成", async () => {
  const f = await fixture();
  const file = join(
    f.config.stateDirectory,
    "skills",
    "missing-description",
    "SKILL.md",
  );
  await mkdir(dirname(file), { recursive: true });
  await Bun.write(file, "---\nname: missing-description\n---\n");
  const report = spyOn(console, "error").mockImplementation(() => {});
  try {
    await f.reopen();
    expect(report.mock.calls).toEqual([
      [expect.objectContaining({ type: "warning", path: file })],
    ]);
    f.faux.setResponses([fauxAssistantMessage("诊断后仍正常工作")]);
    expect((await f.submit("继续")).status).toBe("done");
  } finally {
    report.mockRestore();
  }
});

test("官方四种工具使用 workspace，重启保留文件和工具注册", async () => {
  const f = await fixture("custom/workspace");
  expect((await stat(f.config.workspace)).mode & 0o777).toBe(0o700);
  expect((await f.root.agent(context)).cwd).toBe(f.config.workspace);
  f.faux.setResponses([
    (request) => {
      expect(getCurrentTools(request.messages).map(({ name }) => name)).toEqual(
        [
          "memory_create",
          "read",
          "write",
          "edit",
          "bash",
          "session_read",
          "session_search",
          "schedule",
          "codemode",
        ],
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
