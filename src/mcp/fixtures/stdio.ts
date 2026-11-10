import {
  isJsonRpcRequest,
  LATEST_PROTOCOL_VERSION,
  parseJsonRpcMessage,
} from "@earendil-works/pi-mcp";
import { createInterface } from "node:readline";

const pidFile = process.env["MCP_TEST_PID_FILE"];
if (pidFile) await Bun.write(pidFile, String(process.pid));
const lines = createInterface({ input: process.stdin, terminal: false });
for await (const line of lines) {
  const message = parseJsonRpcMessage(JSON.parse(line));
  if (!isJsonRpcRequest(message)) continue;
  let result: unknown;
  switch (message.method) {
    case "initialize":
      result = {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "stdio-fixture", version: "1" },
      };
      break;
    case "tools/list":
      result = {
        tools: [
          {
            name: "status",
            description: "Return process information",
            inputSchema: { type: "object", properties: {} },
            outputSchema: {
              type: "object",
              properties: {
                pid: { type: "number" },
                cwd: { type: "string" },
                value: { type: "string" },
              },
              required: ["pid", "cwd", "value"],
            },
          },
        ],
      };
      break;
    case "tools/call":
      result = {
        content: [],
        structuredContent: {
          pid: process.pid,
          cwd: process.cwd(),
          value: process.env["MCP_TEST_VALUE"] ?? "",
        },
      };
      break;
    default:
      result = {};
  }
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n",
  );
}
