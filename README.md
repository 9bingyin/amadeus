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
    "servers": [
      {
        "name": "github",
        "transport": "http",
        "url": "https://example.com/mcp",
        "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" },
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

## Codemode

聊天同时提供本地工具和 `codemode`；本地工具可以直接调用，也可以在 JavaScript 中调用。`codemode` 的参数是 `{ "code": "JavaScript 正文" }`，正文按异步函数执行，支持顶层 `await`、`return`、`Promise.all` 和 `Promise.allSettled`。例如：

```js
const results = await Promise.allSettled([
  tools.read({path: "notes.md"}),
  tools.read({path: "todo.md"}),
]);
text(results);
```

运行时是 QuickJS/WASM，复用 PiG 的 codemode 引擎。没有 Node、直接文件／网络访问或计时器；能力只来自注入的 `tools`。脚本拿到本地工具的实际返回值；`read` 返回文本或图片块；用 `image(await tools.read({path: "picture.png"}))` 把图片交给模型。`text()`、`console.log()` 和 `return` 产生文本输出。

`bash` 直接调用和脚本调用都返回 `{output, truncated, full_output_path?, exit_code, wall_time_seconds}`。`output` 是合并的 stdout/stderr，仍保留最后 2000 行或 50KB；截断时 `full_output_path` 指向完整输出文件。命令非零退出也正常返回，通过 `exit_code` 判断；参数错误、启动失败、超时和取消仍报错。已有脚本需要把 bash 结果当字符串使用的地方改为读取 `.output`，并显式检查退出码，不会自动改写。

可选的首行 `// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}` 设置输出预算或显式超时；没有默认脚本超时。默认模型可见输出预算约 10000 token，超长内容保存到 `.tool-outputs`，脚本内仍能拿到完整 MCP 结果并先过滤。原有 `read`／`bash` 的分页和截断规则不变。脚本结束会取消并等待未完成调用；已经完成的外部操作不会回滚。脚本之间不保留 JavaScript 状态，需要持久化时使用已有存储工具或文件。

## MCP

启动时连接，进程退出前保持连接。HTTP 用 `url` 和 `headers`，stdio 用 `command`、`args`、`env`。`headers` 和 `env` 里的 `${NAME}` 在连接时换成同名环境变量，变量不存在就连不上。stdio 子进程还会继承服务自己的环境变量。

本地工具始终直接可见：`read`、`write`、`edit`、`bash`、`session_search`、`session_read`、`send_file`、`schedule`、`memory`。

MCP 工具不直接进入模型的工具列表，只通过 codemode 发现和调用。`ALL_TOOLS` 列出可调用名称和描述；`await searchTools(query, {limit, namespace})` 搜索工具，`await describeTool(name)` 返回完整参数声明，`await describeNamespace(server)` 列出某台服务器的工具。搜索和描述返回的名称可以直接用于 `await tools[name](args)`。

`includeTools` 为空表示允许全部。`excludeTools` 优先。名称可以是 MCP 原名，或 `github__search_repositories` 这种前缀名。`*` 匹配任意长度。

MCP 调用返回完整 `CallToolResult`，包括 `content`、`structuredContent`、`isError`，不会提前提取或截断文本。工具报告的 `isError` 保留在结果中；连接／协议错误会让 Promise reject。被排除的工具不能发现，也不能调用。

升级时必须删除顶层 `mcp.directTools` 和每个 server 的 `directTools`；严格配置解析会拒绝这些旧字段。旧的 `tools_list`／`tool_call` 接口已删除，没有兼容开关。

## 定时任务

`schedule` 可以创建、列出、编辑、删除当前聊天的任务。`when` 有四种：`30m` 或 RFC3339 时间是一次性的，`every 30m` 按间隔重复，五段 cron 按本机时区重复。Telegram 里用 `/schedule` 查看还没结束的任务。

任务正文是 JavaScript，存在 `jobs/<id>/task.js`，与聊天共用 QuickJS 执行器。保存前只编译语法，不执行正文；支持顶层 `await`、`return` 和 `for await`，没有模块导入、`setTimeout`、`fetch` 或 Node 接口。`edit` 只替换脚本，身份和日程不变。脚本的工具全部异步：

- `await tools.agent({prompt})`：独立跑一轮 Agent，复用主 Agent 的模型配置、完整工具集、工作区和提示词（技能、项目规则、记忆等），并继承创建任务的聊天路由；不继承聊天消息历史。
- `await tools.post({text})`：通过 local 平台向主 Agent 报告发生了什么，不是直接发给用户的话。创建任务时就定好身份，例如 `Schedule #1 点外卖提醒`。主 Agent 看到的来源头是一行，例如 `[Schedule #1 点外卖提醒 once Tue 2026-09-22 15:45:00Z]`，后面才是报告。方括号里的时间是 UTC。用户说的钟点和 cron 用系统提示里的时区。回复仍从这条聊天的主平台发出。
- 主 Agent 的工具也可以直接通过 `tools` 调用，包括 `bash`、`read`、`edit`、`write`、会话工具、`memory`、`schedule` 和已启用的 `send_file`。相对路径和 bash 的默认工作目录与主 Agent 相同，没有任务专属的文件隔离；`read` 的分页、图片和文件不存在时报错的行为也相同。
- 允许的 MCP 工具使用与聊天相同的发现和调用接口；会话工具、`schedule` 和 `send_file` 使用创建任务的账户、聊天和线程。

已有 `task.js` 不会自动改写。旧的同步 `agent/post/read/write` 必须手动改为上述异步接口，并等待所有必要调用。原先按任务目录解析的相对路径现在按主工作区解析；要继续使用 `jobs/<id>/` 中的旧文件，请在脚本中改为对应的绝对路径。文件不存在时需要自行处理错误。例如：

```js
let previous = "";
try {
  previous = await tools.read({path: "snapshot.txt"});
} catch (error) {
  if (!String(error).includes("no such file or directory")) throw error;
}
const current = await tools.agent({prompt: "检查目标页面，只返回最新状态"});
if (current !== previous) {
  await tools.write({path: "snapshot.txt", content: current});
  await tools.post({text: current});
}
```

任务 Agent 也可以调用 `post`；报告在脚本成功结束后交给主 Agent。没有调用 `post` 就不会提交报告，但 `send_file` 等工具仍会直接产生外部操作。一次性任务成功后结束。失败会保持待运行，一分钟后再试。同一时刻只跑一条。
