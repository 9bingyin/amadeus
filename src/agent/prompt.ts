import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { arch, platform, release } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

async function readPromptFile(path: string): Promise<string> {
  try {
    return (await Bun.file(path).text()).trim();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return "";
    throw error;
  }
}

export async function createSystemPrompt(
  stateDirectory: string,
  workspace: string,
) {
  const identity =
    (await readPromptFile(join(stateDirectory, "SOUL.md"))) ||
    "You are a personal assistant inside pi durable, an agent harness.";
  const user = await readPromptFile(join(stateDirectory, "USER.md"));
  const distribution =
    platform() === "linux"
      ? parseEnv(await readPromptFile("/etc/os-release"))["PRETTY_NAME"]
      : undefined;
  const system = [distribution, `${platform()} ${release()} ${arch()}`]
    .filter(Boolean)
    .join("; ");
  const projectContext = loadProjectContextFiles({
    agentDir: stateDirectory,
    cwd: workspace,
  })
    .filter(({ content }) => content.trim())
    .map(
      ({ path, content }) =>
        `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
    )
    .join("\n\n");
  return defineExtension({
    name: "amadeus.system-prompt",
    sections: [
      section("preamble", () => identity, { tag: false }),
      // 工具使用规则沿用 pi coding agent，工具声明由 Durable 提供。
      section(
        "rules",
        () => `- Use bash for file operations like ls, rg, find
- Use read to examine files instead of cat or sed.
- Use edit for targeted changes. Batch changes to one file in a single call.
- Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.
- Use write only for new files or complete rewrites.
- Be concise in your responses
- Show file paths clearly when working with files`,
      ),
      section("project_context", () => projectContext || undefined),
      section("user", () => user || undefined),
      section("system", () => {
        const time = new Intl.DateTimeFormat("en", {
          timeZoneName: "longOffset",
        });
        const offset = time
          .formatToParts()
          .flatMap((part) => (part.type === "timeZoneName" ? [part.value] : []))
          .join("");
        // 只保留时区和当前偏移，不注入不断变化的时钟时间。
        return `${system}\nTimezone: ${time.resolvedOptions().timeZone} (${offset})`;
      }),
      section("cwd", ({ env }) => env?.cwd),
    ],
  });
}
