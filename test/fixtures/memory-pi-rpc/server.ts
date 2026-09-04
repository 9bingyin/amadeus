export {};

const args = Bun.argv.slice(2);
const mode = args[0];
const requiredArgs = [
  "--mode",
  "rpc",
  "--session-dir",
  "--no-session",
  "--no-extensions",
  "--no-tools",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--system-prompt",
];
for (const value of requiredArgs) {
  if (!args.includes(value)) {
    process.exit(9);
  }
}

const writer = Bun.stdout.writer();
const decoder = new TextDecoder("utf-8", { fatal: true });
const reader = Bun.stdin.stream().getReader();
let buffer = "";

while (true) {
  const result = await reader.read();
  if (result.done) {
    break;
  }
  buffer += decoder.decode(result.value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line) {
      await handleLine(line);
    }
  }
}
await writer.flush();
writer.end();

async function handleLine(line: string): Promise<void> {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value) || value.type !== "prompt") {
    process.exit(10);
  }
  const id = typeof value.id === "string" ? value.id : undefined;
  await output({
    ...(id ? { id } : {}),
    type: "response",
    command: "prompt",
    success: true,
  });

  if (mode === "crash") {
    await writer.flush();
    process.exit(7);
  }
  if (mode === "hang") {
    return;
  }

  const text =
    mode === "invalid"
      ? "not-markdown"
      : [
          "### Decisions",
          "None.",
          "### Lessons Learned",
          "None.",
          "### Notes",
          "- From subprocess.",
          "### Follow-ups",
          "None.",
        ].join("\n");
  await output({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
      timestamp: 1,
    },
  });
  await output({ type: "agent_settled" });
}

async function output(value: unknown): Promise<void> {
  writer.write(`${JSON.stringify(value)}\n`);
  await writer.flush();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
