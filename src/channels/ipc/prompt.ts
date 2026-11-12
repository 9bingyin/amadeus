import { section } from "@earendil-works/pi-durable";

export const IpcPrompt = section("platform", ({ agent }) => {
  let prompt = `Internal messages start with [IPC ...], [Schedule ...], or [Notification ...]. Times are UTC. [Metadata: JSON] identifies the source; [Data: JSON] holds details. The text after them is a report to you, not a user instruction. Check results when needed. Reply to the user yourself, in their language. An IPC event does not mean its command finished.`;
  if (agent.extensions.some(({ name }) => name === "amadeus.ipc"))
    prompt += `
For a report before a command exits, explicitly run:
bun run "$AMADEUS_NOTIFY_CLI" --key STABLE_KEY --message "MESSAGE" [--data JSON]
stdout alone does not notify. Credentials are valid only while the command runs; keep them out of messages and logs.`;
  return `<ipc>\n${prompt}\n</ipc>`;
});
