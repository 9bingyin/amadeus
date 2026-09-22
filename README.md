# Amadeus

Amadeus 是个人助手。对话记在本地，可以搜回以前的会话，也可以在上下文变长时压缩。

它能读写工作目录里的文件、执行命令，并把文件发回去。需要别的能力时，可以挂上 MCP 服务，按服务器查看工具再调用。身份和习惯写在 `SOUL.md`、`AGENTS.md` 里。

## 运行

配置在 `$AMADEUS_HOME/config.json`。未设置 `AMADEUS_HOME` 时，主目录是 `~/.amadeus`。相对路径按启动时的当前目录解析。

同一主目录同时只能有一个进程。第二个进程发现 `amadeus.lock` 后直接退出。

```sh
nix develop
go run ./cmd/amadeus
```

主目录里还会用到：

- `state.db`：会话记录
- `workspace/`：文件工具的工作目录，可用配置里的 `workspace` 改成其他相对或绝对路径
- `SOUL.md`、`AGENTS.md`：写进系统提示；工作目录里的 `AGENTS.md` 单独成一节
- `skills/`：技能
- `attachments/`：Telegram 收到的附件

Telegram 命令：`/new` 开启新会话，`/compact` 压缩当前会话，`/status` 查看状态。

## 配置

不认识的字段会拒绝加载。

```json
{
  "workspace": "workspace",
  "gateway": { "inputWindowMs": 700 },
  "logging": { "level": "info", "format": "text", "addSource": false },
  "models": {
    "assistant": {
      "provider": "default",
      "id": "gpt-5-mini",
      "reasoningEffort": "medium",
      "contextWindowTokens": 128000
    },
    "embed": {
      "provider": "default",
      "id": "text-embedding-3-small",
      "input": ["embeddings"]
    }
  },
  "model": "assistant",
  "providers": {
    "default": {
      "api": "openai-responses",
      "apiKey": "replace-with-api-key",
      "baseURL": "https://api.openai.com/v1",
      "httpVersion": "auto",
      "headers": { "X-Example": "value" }
    }
  },
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "maxAgentDelayMs": 60000
  },
  "telegram": {
    "enabled": true,
    "botToken": "123456789:replace-with-telegram-bot-token",
    "allowedUserIDs": [123456789]
  },
  "search": { "engine": "fts5", "model": "embed" },
  "mcp": {
    "directTools": false,
    "servers": [
      {
        "name": "github",
        "transport": "http",
        "url": "https://example.com/mcp",
        "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" },
        "directTools": ["get_file_contents"],
        "includeTools": ["search_*", "get_*"],
        "excludeTools": ["delete_*"]
      },
      {
        "name": "local",
        "transport": "stdio",
        "command": "mcp-server",
        "args": ["--stdio"],
        "env": { "TOKEN": "${TOKEN}" }
      }
    ]
  }
}
```

`model` 必须指向 `models` 里的一项。`models.*.provider` 必须指向 `providers`。对话模型的 `input` 至少要有 `text`、`image`、`file` 之一；省略时只有 `text`。`contextWindowTokens` 省略时是 128000。

`providers.*.api` 目前只有 `openai-responses`。`httpVersion` 是 `auto` 或 `1.1`。`headers` 会原样加到模型请求上。

`search.engine` 是 `fts5` 或 `vector`。`vector` 必须设置 `search.model`，且该模型的 `input` 包含 `embeddings`。

`gateway.inputWindowMs` 默认 700。`logging.level` 是 `debug`、`info`、`warn`、`error`，默认 `info`。`logging.format` 是 `text` 或 `json`，默认 `text`。压缩和重试的默认值与上面的示例相同。`telegram.enabled` 必须为 true。

## MCP

启动时连接，进程退出前保持连接。HTTP 用 `url` 和 `headers`，stdio 用 `command`、`args`、`env`。`headers` 和 `env` 里的 `${VAR}` 会展开成环境变量。

本地工具始终直接可见：`read`、`write`、`edit`、`bash`、`session_search`、`session_read`、`send_file`。

MCP 工具默认不进入模型的工具列表。`mcp.directTools` 只接受布尔值，默认 `false`。每个 server 可以再覆盖：

- `true`：该 server 允许的工具都直接可见
- `false`：全部隐藏
- 名称列表：只让列出的工具直接可见
- 不写：继承顶层

`includeTools` 为空表示允许全部。`excludeTools` 优先。名称可以是 MCP 原名，或 `github__search_repositories` 这种前缀名。`*` 匹配任意长度。

有隐藏工具时才注册 `tools_list` 和 `tool_call`。`tools_list` 不带参数只列出服务器名；带上 `server` 才列出该服务器的工具和参数。然后用 `tool_call` 调用。被排除的工具不能列出，也不能调用。
