import { copyJson } from "@earendil-works/chord/json";
import {
  defineExtension,
  section,
  type Extension,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import {
  createMcpToolName,
  McpClient,
  mcpNamespace,
  normalizeMcpInputSchema,
  StdioTransport,
  StreamableHttpTransport,
  toLlmContent,
  type Tool,
} from "@earendil-works/pi-mcp";
import { pathToFileURL } from "node:url";
import type { Config } from "../config";

export type Mcp = {
  extension: Extension;
  namespaces: CodemodeNamespace[];
  close(): Promise<void>;
};

export async function openMcp(
  servers: Config["mcpServers"],
  workspace: string,
): Promise<Mcp> {
  const clients: McpClient[] = [];
  const entries: { server: string; client: McpClient; tool: Tool }[] = [];
  const namespaces: CodemodeNamespace[] = [];
  let closed = false;
  async function close(): Promise<void> {
    closed = true;
    const results = await Promise.allSettled(
      clients.map((client) => client.close()),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }
  try {
    for (const [server, entry] of Object.entries(servers)) {
      const config = entry.config;
      if (config.enabled === false) continue;
      const client = new McpClient({
        name: "amadeus",
        version: "1.0.0",
        roots: [{ uri: pathToFileURL(workspace).href, name: "workspace" }],
        ...(config.timeout === undefined
          ? {}
          : { requestTimeoutMs: config.timeout * 1000 }),
      });
      clients.push(client);
      client.onError((error) => {
        if (!closed) console.error(error);
      });
      await client.connect(
        entry.kind === "stdio"
          ? new StdioTransport({
              command: entry.config.command,
              args: entry.config.args ?? [],
              env: entry.config.env ?? {},
              cwd: entry.config.cwd ?? workspace,
              stderr: "inherit",
            })
          : new StreamableHttpTransport({
              url: entry.config.url,
              headers: entry.config.headers ?? {},
            }),
      );
      for (const tool of await client.listTools())
        entries.push({ server, client, tool });
      const name = mcpNamespace(server);
      namespaces.push({
        name,
        prefix: `${name}__`,
        ...(config.description === undefined
          ? {}
          : { description: config.description }),
        ...(client.instructions === undefined
          ? {}
          : { instructions: client.instructions }),
      });
    }
    // 与官方 Durable 适配一致：冲突名称都加稳定哈希，不依赖服务返回的工具顺序。
    const plain = new Map<string, number>();
    for (const { server, tool } of entries) {
      const name = createMcpToolName(server, tool.name);
      plain.set(name, (plain.get(name) ?? 0) + 1);
    }
    const assigned = new Set<string>();
    const tools = entries.map(({ server, client, tool }): ToolRegistration => {
      const name = createMcpToolName(
        server,
        tool.name,
        (candidate) =>
          (plain.get(candidate) ?? 0) > 1 || assigned.has(candidate),
      );
      assigned.add(name);
      return {
        name,
        description: tool.description ?? tool.title ?? tool.name,
        parameters: normalizeMcpInputSchema(tool.inputSchema),
        callers: ["tools"],
        deferred: true,
        ...(tool.outputSchema === undefined
          ? {}
          : { structuredOutputSchema: tool.outputSchema }),
        async execute(args, api, context) {
          // Harness 已按运行时的 object schema 校验参数，类型无法从远端 schema 推导。
          const result = await client.callTool(
            tool.name,
            args as Record<string, unknown>,
            {
              ...(context.abortSignal === undefined
                ? {}
                : { signal: context.abortSignal }),
              onProgress: (progress) =>
                api.output(progress.message ?? String(progress.progress)),
            },
          );
          return {
            output: toLlmContent(result),
            isError: result.isError === true,
            details: { server, tool: tool.name },
            ...(tool.outputSchema === undefined ||
            result.structuredContent === undefined
              ? {}
              : { structuredOutput: copyJson(result.structuredContent) }),
          };
        },
      };
    });
    return {
      extension: defineExtension({
        name: "amadeus.mcp",
        tools,
        sections: namespaces.length
          ? [
              section("mcp_servers", () =>
                [
                  "MCP tools are available only from codemode scripts. Find them with searchTools() or describeNamespace().",
                  ...namespaces.map(
                    ({ name, description }) =>
                      `- ${name}${description ? `: ${description}` : ""}`,
                  ),
                ].join("\n"),
              ),
            ]
          : [],
      }),
      namespaces,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
