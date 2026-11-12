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
  section,
  type Conversation,
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

test("Injects command-scoped IPC credentials and deduplicates notifications", async () => {
  const f = await fixture("work space", true);
  f.faux.setResponses([
    (request) => {
      expect(getCurrentSystemPrompt(request.messages)).toContain(
        "AMADEUS_NOTIFY_CLI",
      );
      return call("bash", {
        command:
          'bun run "$AMADEUS_NOTIFY_CLI" --key release --message "Release changed" --data \'{"version":"1.3"}\'; bun run "$AMADEUS_NOTIFY_CLI" --key release --message "Release changed" --data \'{"version":"1.3"}\'',
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
      return fauxAssistantMessage("Command completed");
    },
    (request) => {
      const input = request.messages.findLast(
        (message) => message.role === "user",
      );
      expect(contentText(input?.content ?? [])).toContain("Release changed");
      return fauxAssistantMessage("A new release needs an upgrade decision.");
    },
  ]);
  await f.submit("Run the check");
  const history = await f.root.entries({}, 100, undefined, context);
  expect(history.items.filter(NotificationEntry.is)).toHaveLength(1);
  expect(f.faux.state.callCount).toBe(3);
});

test("Supports IPC from codemode without treating stdout as a notification", async () => {
  const f = await fixture("workspace", true);
  f.faux.setResponses([
    call("codemode", {
      code: 'const result = await tools.bash({command: \'printf "ordinary output\\n"; bun run "$AMADEUS_NOTIFY_CLI" --key nested --message "Follow-up needed"\'}); text(result.exitCode);',
    }),
    fauxAssistantMessage("Background result saved"),
    (request) => {
      const input = request.messages.findLast(
        (message) => message.role === "user",
      );
      expect(contentText(input?.content ?? [])).toContain("Follow-up needed");
      expect(contentText(input?.content ?? [])).not.toContain(
        "ordinary output",
      );
      return fauxAssistantMessage("Notification handled");
    },
  ]);
  await f.submit("Run the script");
  expect(
    (await f.root.entries({}, 100, undefined, context)).items.filter(
      NotificationEntry.is,
    ),
  ).toHaveLength(1);
  expect(f.faux.state.callCount).toBe(3);
});

test("Exposes schedule management through codemode", async () => {
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
      return fauxAssistantMessage("Schedule removed");
    },
  ]);
  expect((await f.submit("Manage scheduled scripts")).status).toBe("done");
});

test("Keeps scheduled workers isolated from delivery tools and IPC credentials", async () => {
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
        return fauxAssistantMessage("Permissions checked; no report needed.");
      }
      const last = request.messages.findLast(
        (message) => message.role !== "system",
      );
      if (last?.role === "toolResult") return fauxAssistantMessage("Scheduled");
      return call("schedule", {
        action: "create",
        name: "worker",
        prompt: "Check tool permissions and finish silently",
        when: { kind: "after", delayMs: 0 },
      });
    }),
  );
  expect((await f.submit("Start a scheduled worker")).status).toBe("done");
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

test("Preserves existing IPC files and releases the lock after startup failure", async () => {
  const f = await fixture("workspace", true);
  await f.close();
  const socket = join(f.config.stateDirectory, "ipc", "notify.sock");
  await Bun.write(socket, "preserve existing data");
  await expect(f.reopen()).rejects.toBeInstanceOf(ZodError);
  expect(await Bun.file(socket).text()).toBe("preserve existing data");
  await rm(socket);
  await f.reopen();
  f.faux.setResponses([fauxAssistantMessage("Startup recovered")]);
  expect((await f.submit("Continue")).status).toBe("done");
});

test("Refreshes memory metadata after native file edits without preloading bodies", async () => {
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
      return fauxAssistantMessage("Memory note removed");
    },
  ]);
  expect(
    (await f.submit("Create, read, correct, and remove this memory")).status,
  ).toBe("done");
  expect(await Bun.file(path).exists()).toBe(false);
  expect(await Bun.file(index).text()).toContain("No topics yet.");
});

test("Creates and reads memory topics through codemode", async () => {
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
      return fauxAssistantMessage("Topic created");
    },
  ]);
  expect((await f.submit("Create memory through codemode")).status).toBe(
    "done",
  );
});

test("Keeps memory under application HOME across reset, restart, and cwd changes", async () => {
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
      return fauxAssistantMessage("Catalog unchanged");
    },
  ]);
  expect((await f.submit("Read the memory catalog")).status).toBe("done");
  expect(await Bun.file(file).text()).toContain("private-persistent-body");
});

test("Preserves memory validation errors and releases startup resources", async () => {
  const f = await fixture();
  const file = join(f.config.stateDirectory, "memory", "topics", "broken.md");
  await Bun.write(file, "---\ntitle: Missing summary\n---\nbody");
  await expect(f.reopen()).rejects.toBeInstanceOf(ZodError);
  await rm(file);
  await f.reopen();
  f.faux.setResponses([fauxAssistantMessage("Startup succeeds after the fix")]);
  expect((await f.submit("Continue")).status).toBe("done");
});

test("Installs history tools for codemode reads after restart and reset", async () => {
  const f = await fixture();
  f.faux.setResponses([fauxAssistantMessage("Remembered")]);
  await f.submit("startup-integration: database migration plan");
  await f.reopen();
  await f.root.reset(undefined, context);
  f.faux.setResponses([
    call("codemode", {
      code: `
        const found = await tools.session_search({ query: "startup-integration" });
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
        "startup-integration: database migration plan",
      );
      return fauxAssistantMessage("History restored");
    },
  ]);
  expect((await f.submit("Read earlier history")).status).toBe("done");
});

test("Composes native prompt sections and clears saved instructions on restart", async () => {
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
      expect(prompt).not.toContain("You are Amadeus");

      return fauxAssistantMessage("System prompt loaded");
    };
  }
  f.faux.setResponses([response(f.config.workspace)]);
  expect((await f.submit("Check the system prompt")).status).toBe("done");
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
  expect((await f.submit("Continue after restart")).status).toBe("done");
});

test("Reloads SOUL identity and removes obsolete prompt sections", async () => {
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
      return fauxAssistantMessage("Old prompt saved");
    },
  ]);
  expect((await f.submit("Old prompt")).status).toBe("done");
  const path = join(f.config.stateDirectory, "SOUL.md");
  await Bun.write(
    join(f.config.workspace, "SOUL.md"),
    "workspace-identity-must-not-load",
  );
  for (const text of [
    "  You are Amadeus. Lead with the conclusion.\nKeep internal line breaks。\n",
    "You are Amadeus with an updated identity.",
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
        if (!text.includes("Keep internal line breaks"))
          expect(prompt).not.toContain("Keep internal line breaks");
        if (!text.trim()) expect(prompt).not.toContain("updated identity");
        return fauxAssistantMessage("Identity updated");
      },
    ]);
    expect((await f.submit("Check the identity")).status).toBe("done");
  }
});

for (const file of ["SOUL.md", "USER.md"]) {
  test(`Preserves ${file} read errors and releases the startup lock`, async () => {
    const f = await fixture();
    const path = join(f.config.stateDirectory, file);
    await mkdir(path);
    await expect(f.reopen()).rejects.toMatchObject({ code: "EISDIR", path });
    await rm(path, { recursive: true });
    await f.reopen();
    f.faux.setResponses([fauxAssistantMessage("Startup works again")]);
    expect((await f.submit("Continue")).status).toBe("done");
  });
}

test("Loads AGENTS and HOME user context as startup snapshots", async () => {
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
      return fauxAssistantMessage("Context loaded");
    },
  ]);
  expect((await f.submit("Check context")).status).toBe("done");
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
      return fauxAssistantMessage("Context updated");
    },
  ]);
  expect((await f.submit("Check again")).status).toBe("done");
});

test("Deduplicates shared HOME context and omits an empty user profile", async () => {
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
      return fauxAssistantMessage("Context is not duplicated");
    },
  ]);
  expect((await f.submit("Check deduplication")).status).toBe("done");
});

test("Loads skill catalogs at startup and reads bodies and scripts on demand", async () => {
  const f = await fixture();
  f.faux.setResponses([
    (request) => {
      expect(getCurrentSystemPrompt(request.messages)).not.toContain(
        "<available_skills>",
      );
      return fauxAssistantMessage("Runs without skills");
    },
  ]);
  expect((await f.submit("Start")).status).toBe("done");
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
      return fauxAssistantMessage("Skill completed");
    },
  ]);
  expect((await f.submit("Generate a report")).status).toBe("done");
});

test("Refreshes skill descriptions on restart", async () => {
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
        return fauxAssistantMessage("Skills refreshed");
      },
    ]);
    expect((await f.submit("Check available skills")).status).toBe("done");
  }
});

test("Reports original skill diagnostics without blocking startup", async () => {
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
    f.faux.setResponses([
      fauxAssistantMessage("Runs after reporting diagnostics"),
    ]);
    expect((await f.submit("Continue")).status).toBe("done");
  } finally {
    report.mockRestore();
  }
});

test("Installs native coding tools in the configured workspace", async () => {
  const f = await fixture("custom/workspace");
  expect((await stat(f.config.workspace)).mode & 0o777).toBe(0o700);
  expect((await f.root.agent(context)).cwd).toBe(f.config.workspace);
  f.faux.setResponses([
    (request) => {
      expect(getCurrentTools(request.messages).map(({ name }) => name)).toEqual(
        expect.arrayContaining(["read", "write", "edit", "bash", "codemode"]),
      );
      return call("bash", { command: "pwd" });
    },
    (request) => {
      const result = request.messages.findLast(
        (message) => message.role === "toolResult",
      );
      expect(result?.isError).toBe(false);
      expect(contentText(result?.content ?? []).trim()).toBe(
        f.config.workspace,
      );
      return fauxAssistantMessage("Done");
    },
  ]);
  expect((await f.submit("Check the workspace")).status).toBe("done");
});

test("Exposes native tools through codemode without leaking nested results", async () => {
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
      return fauxAssistantMessage("Codemode completed");
    },
  ]);
  expect((await f.submit("Process the data")).status).toBe("done");
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
      return fauxAssistantMessage("State restored");
    },
  ]);
  expect((await f.submit("Read saved state")).status).toBe("done");
  expect(f.faux.state.callCount).toBe(4);
});
