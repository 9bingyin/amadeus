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

- `state.db`：会话记录和定时任务
- `jobs/`：每个定时任务一个目录，里面是脚本和要留下的文件
- `workspace/`：文件工具的工作目录，可用配置里的 `workspace` 改成其他相对或绝对路径
- `SOUL.md`、`AGENTS.md`：写进系统提示；工作目录里的 `AGENTS.md` 单独成一节
- `USER.md`、`MEMORY.md`：跨会话记住的事实，写在系统提示最后。`USER.md` 是这个人是谁，`MEMORY.md` 是记住的事。工作流写在 `AGENTS.md`。下一轮才会进提示词。某一份用到上限的八成、并且没有进行中的回合时，会把它改短；同一份内容只整理一次
- `skills/`：技能
- `attachments/`：Telegram 收到的附件

Telegram 命令：`/new` 开启新会话，`/compact` 压缩当前会话，`/status` 查看状态。

## NixOS

把 `amadeus.nixosModules.default` 加进系统模块。服务是 `services.amadeus`，主目录是 `/var/lib/amadeus`。

- `enable`：开机启动
- `package`：用哪个包，默认是这个 flake 的包
- `user`：已有用户。不设时以 root 运行，不会新建用户
- `configFile`、`settings`：二选一。`configFile` 是运行时的 JSON 路径，启动时复制到主目录的 `config.json`。`settings` 是同一份配置，写在 Nix 里。字段见下一节
- `environmentFile`：systemd 的环境变量文件，不进 Nix store。`apiKey`、`botToken`、MCP 的 `headers` 和 `env` 写成 `${NAME}`，从这里取值
- `extraPackages`：加进服务 PATH。`bash` 和 `coreutils` 一直在

sops-nix 把每个机密解密成一个文件。用 template 拼成 `KEY=value`，再交给 `environmentFile`。服务不是 root 时，这些 secret 的 owner 要设成同一个用户。

```nix
sops.secrets.openai_api_key = { };
sops.secrets.telegram_bot_token = { };
sops.secrets.github_token = { };
sops.templates."amadeus.env".content = ''
  OPENAI_API_KEY=${config.sops.placeholder.openai_api_key}
  TELEGRAM_BOT_TOKEN=${config.sops.placeholder.telegram_bot_token}
  GITHUB_TOKEN=${config.sops.placeholder.github_token}
'';

services.amadeus = {
  enable = true;
  environmentFile = config.sops.templates."amadeus.env".path;
  settings = {
    model = "assistant";
    models.assistant = {
      provider = "default";
      id = "gpt-5-mini";
      contextWindowTokens = 128000;
    };
    providers.default = {
      api = "openai-responses";
      apiKey = "\${OPENAI_API_KEY}";
    };
    telegram = {
      enabled = true;
      botToken = "\${TELEGRAM_BOT_TOKEN}";
      allowedUserIDs = [ 123456789 ];
    };
    mcp.servers = [
      {
        name = "github";
        transport = "http";
        url = "https://example.com/mcp";
        headers.Authorization = "Bearer \${GITHUB_TOKEN}";
      }
    ];
  };
};
```

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
    "keepRecentTokens": 20000,
    "idle": { "enabled": true, "afterMs": 2700000 }
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

`providers.*.api` 目前只有 `openai-responses`。`httpVersion` 是 `auto` 或 `1.1`。模型请求的 `headers` 里，`{session}` 和 `{conversation}` 按当前会话替换。`apiKey` 和 `telegram.botToken` 里的 `${NAME}` 会换成同名环境变量，变量不存在就拒绝启动。没有 `${}` 的值保持原样。

`search.engine` 是 `fts5` 或 `vector`。`vector` 必须设置 `search.model`，且该模型的 `input` 包含 `embeddings`。

`gateway.inputWindowMs` 默认 700。`logging.level` 是 `debug`、`info`、`warn`、`error`，默认 `info`。`logging.format` 是 `text` 或 `json`，默认 `text`。压缩和重试的默认值与上面的示例相同。`compaction.idle` 默认开：用户 `afterMs`（默认 45 分钟）没有发消息，并且这段历史还能压缩时，后台静默压一次。local 平台的报告不算用户发消息。`compaction.enabled` 为 false 时不会自动压缩。`telegram.enabled` 必须为 true。

## MCP

启动时连接，进程退出前保持连接。HTTP 用 `url` 和 `headers`，stdio 用 `command`、`args`、`env`。`headers` 和 `env` 里的 `${NAME}` 在连接时换成同名环境变量，变量不存在就连不上。stdio 子进程还会继承服务自己的环境变量。

本地工具始终直接可见：`read`、`write`、`edit`、`bash`、`session_search`、`session_read`、`send_file`、`schedule`、`memory`。

MCP 工具默认不进入模型的工具列表。`mcp.directTools` 只接受布尔值，默认 `false`。每个 server 可以再覆盖：

- `true`：该 server 允许的工具都直接可见
- `false`：全部隐藏
- 名称列表：只让列出的工具直接可见
- 不写：继承顶层

`includeTools` 为空表示允许全部。`excludeTools` 优先。名称可以是 MCP 原名，或 `github__search_repositories` 这种前缀名。`*` 匹配任意长度。

有隐藏工具时才注册 `tools_list` 和 `tool_call`。`tools_list` 不带参数只列出服务器名；带上 `server` 才列出该服务器的工具和参数。然后用 `tool_call` 调用。被排除的工具不能列出，也不能调用。

## 定时任务

`schedule` 可以创建、列出、编辑、删除当前聊天的任务。`when` 有四种：`30m` 或 RFC3339 时间是一次性的，`every 30m` 按间隔重复，五段 cron 按本机时区重复。Telegram 里用 `/schedule` 查看还没结束的任务。

任务正文是 JavaScript，存在 `jobs/<id>/task.js`。保存前会用 goja 编译，语法不对就写不进去。不能写 `import`、`export`、顶层 `await`、`for await`、异步生成器、装饰器或 `using`。`setTimeout`、`fetch` 和 Node 接口都不存在。`agent`、`post`、`read`、`write` 都是同步的。`edit` 只替换脚本，身份和日程不变。脚本可以调用：

- `agent(prompt)`：用这次任务自己的提示词和工作目录跑一轮。文件工具只碰这个目录。浏览器之类的能力仍走 MCP。
- `post(text)`：通过 local 平台向主 Agent 报告发生了什么，不是直接发给用户的话。创建任务时就定好身份，例如 `Schedule #1 点外卖提醒`。主 Agent 看到的来源头是一行，例如 `[Schedule #1 点外卖提醒 once Tue 2026-09-22 15:45:00Z]`，后面才是报告。方括号里的时间是 UTC。用户说的钟点和 cron 用系统提示里的时区。回复仍从这条聊天的主平台发出。
- `read(path)`、`write(path, text)`：读写这个任务目录。文件不存在时 `read` 返回空字符串。

任务 Agent 也可以调用 `post`。没有调用 `post` 就不会打扰这条聊天。一次性任务成功后结束。失败会保持待运行，一分钟后再试。同一时刻只跑一条。
