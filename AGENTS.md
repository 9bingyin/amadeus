# 项目约定

- 坚持简洁设计：除非有明确需求，不为 Agent 循环引入固定调用次数、超时、重试、Token、费用或轮次等人为限制。
- 使用 Bun + TypeScript，以 pi-durable 作为 Agent 运行框架。
- 使用 flake-parts + direnv 管理开发环境（`use flake`）。
- 使用 treefmt 统一格式化：`nix fmt`；使用 `nix flake check` 检查格式。
- `.test_home/` 保留旧实现的本地数据，不提交 Git；未经明确要求，不修改或迁移其中的数据。
- `AMADEUS_HOME` 指定应用主目录，未设置或为空时默认 `~/.amadeus`；相对路径按启动时的当前目录解析。默认读取其中的 `config.json`，命令行可指定其他配置文件，但不改变状态目录；配置中不另设 `stateDirectory`。
- 凭据直接填写在 `config.json` 的 `channels.telegram.token` 和 `providers.<id>.apiKey`，不提供凭据环境变量映射或回退；`AMADEUS_HOME` 仅负责目录选择。
- HOME 中的 `session.sqlite` 保存 pi-durable 数据，`amadeus.lock` 使用非阻塞 `flock` 保证单写者；先取得锁再打开存储，先关闭 Harness 再释放锁，不删除锁文件，不另建锁数据库。

# 实现规范

- 以当前依赖的官方文档和推荐接口为准，不照搬旧实现，不为兼容旧架构添加适配层。
- 按功能划分目录：`src/config/` 负责配置，`src/agent/` 负责 Agent 与模型，`src/channels/` 是接入层，其中 `telegram/` 负责 Telegram 对接；`src/main.ts` 只负责组装和启动。
- 配置按 pi coding agent 分层：`agent` 只放原生模型引用 `{ provider, modelId }`、`thinkingLevel` 和 `instructions`；`providers` 按 provider ID 保存连接、凭据、`models` 与 `modelOverrides`。`src/agent/providers.ts` 只组装官方 provider 与 API，不重写协议或认证流程；仅注册显式配置的 provider，凭据与 headers 按字面值使用，不执行命令或展开变量。内置目录保留聊天、分类与图像模型，自定义聊天协议支持 Responses、Chat Completions、Anthropic Messages 和 Google Generative AI。自定义模型继承同 ID 的已知元数据，未知模型必须填写 contextWindow/maxTokens，不猜测上下文或输出能力；modelOverrides 只修改已知条目，嵌套能力字段按 pi 规则合并，不另加运行限制。
- 接入配置放在 `channels.<平台>`，缺省表示不启用，至少配置一个已实现的接入。接入各自负责鉴权、外部路由、消息封装和入出站任务，通过原生 Conversation API 使用共享 Harness；不提前统一跨平台用户 ID 或合并会话，不引入通用消息总线或接入 Manager。公共接入层统一进程信号、Harness resume 与所有接入的停止收尾；平台只实现 `run(signal)`，不得关闭共享 Harness。平台目录重构不改持久化的文档、任务 kind 或 requestId。
- 基础工具直接安装官方 `createCodingTools`（`read`、`write`、`edit`、`bash`），通过 `NodeExecutionEnv` 执行，图片读取使用官方 Photon。默认工作目录是 `$AMADEUS_HOME/workspace`，可用 `workspace` 覆盖，配置中的相对路径按应用 HOME 解析；工作目录由原生 agent `cwd` 保存，不自行实现工具调度、取消或恢复。工具具有当前用户的本机权限，工作目录不是沙箱。
- codemode 直接安装官方 `createCodemodeExtension` 和 `CodemodeSandbox`；按官方默认 `on` 模式保留基础工具的直接调用；脚本通过 `tools.*` 统一编排基础工具、MCP 和其他可调用工具，不作为 MCP 专用入口。声明、发现、store/load、嵌套调用及恢复日志均使用原生机制，不自行实现脚本执行或持久化；生命周期通过原生 `AsyncDisposableStack` 管理，按 Harness/storage → 沙箱 → MCP → 目录锁释放；保留共享的关闭 Promise，使并发 `close()` 都等待完整清理。
- MCP 使用官方 `@earendil-works/pi-mcp`，配置在 `mcpServers`；支持 stdio 和 Streamable HTTP，`env` / `headers` 直接填写，不展开环境变量引用。stdio 默认在 workspace 启动，显式 `cwd` 的相对路径按应用 HOME 解析。启动时连接并发现工具，不做 OAuth、配置热更新或自建重连；工具按官方命名、schema 和内容转换注册为 `callers: ["tools"]`、`deferred: true`，只通过 codemode 发现和调用。关闭顺序为 Harness → 沙箱 → MCP 连接 → 目录锁。
- 优先直接使用库的能力：grammY 负责命令匹配、过滤和中间件；pi-durable 负责会话、提交、任务、取消及恢复。不重复实现库已有的机制。
- Telegram 入站先用原生 display-only `write` 保存每条消息并以 `requestId` 去重，再用 `defineTask` / `sleepUntil()` 收集固定窗口内的文本、图片和 caption。窗口默认 700ms，可通过 `channels.telegram.inputWindowMs` 配置，不随后续消息滑动；接入 handler 不等待窗口或下载。
- 入站时将发送者、Telegram 原始 UTC 时间、回复预览和转发来源封装进文本，收据条目只保存文本和图片文件 ID；路由由批次承载，去重使用原生 requestId，不重复保存消息 ID、update ID 或 media group ID，也不保存完整 Telegram 消息或原始 update JSON。每条消息的文本块在对应图片块之前，合批后仍保留各自元数据。
- 批次收据统一保存在 task-scoped 文档中，首条不特殊存放，checkpoint 只记录阶段；收集结束后不再追加。批次按接收顺序提交，避免慢图片被后批消息越过；所有 `input` 均使用内容块数组，包括单条纯文本。运行中输入使用原生 `steer`，`steeringMode` / `followUpMode` 均为 `all`，不因补充消息抢占模型或工具。
- “正在输入”是非持久化状态：通过原生 `observeDoc` / `observeTaskGraph` 观察 Telegram 路由与未完成工作，按聊天和话题共享，立即发送并每 4 秒续期；空闲、取消或 Harness 关闭时停止并取消在途请求，重启按未完成工作恢复。状态请求不阻塞 Agent，失败只原样报告，不添加持久化 typing 任务。
- 成功回复通过 `GenerationTask.afterRun` 返回 `runEndTask`，发送属于当前运行，不维护额外发送链。目标和输入来源水位存于 typed entry；按本轮最新已接纳输入选择来源，在进入发送阶段的原子检查点抑制过时回答及错误，开始发送后不追溯撤回。
- 失败通知依据 submission 结算结果持久化处理，不能只依赖 `afterRun` 或瞬时监听；入站准备错误保留原始报告。图片使用官方 Photon 处理组件及模型图片限制，带 Bot token 的下载地址不作为模型输入；已知模型继承官方能力，自定义模型可用 `providers.<id>.models[].input` 声明 `text` / `image`。
- 命令绕过收集窗口，只有参数校验通过的 `/stop`、`/new` 记录处理收据，其原生取消范围包含收集、下载及发送任务；只读命令和参数错误不持久化去重，重复 update 可以重复回复。普通命令回执直接使用 `ctx.reply()`，不保证崩溃后补发；收据不代表命令副作用原子执行，Telegram 发送也不承诺严格 exactly-once。
- 只实现当前需求，尽量减少封装、抽象、兼容逻辑和防御性分支；但保留权限、数据保护和存储单写者等必要安全边界。
- 类型断言（`as`）和非空断言（`!`）优先通过类型收窄消除；确需保留时，在使用处注释说明库的兼容问题或成立的流程前提，不堆叠冗余运行时检查。

# 错误处理

- 当前阶段直接输出原始错误对象或上游错误内容，保留堆栈和附加字段；不包装错误，不替换成通用失败提示，不自行添加错误文案。
- 尽量不手写 `throw new Error`，不为流程自身已保证存在的会话、路由、输入记录添加重复检查。
- 底层库负责的校验交给底层；必要的配置校验统一使用 Zod，直接输出原始 `ZodError`。
- `catch` 仅用于必要的资源释放、正常取消处理或原样输出、重抛错误；不吞掉真实异常。入站准备仅捕获图片能力校验、下载和处理错误，不把事务提交或框架异常转换成普通输入失败。正常停止和重置不视为错误。

# 测试

- 只保留必要的应用层测试，重点覆盖权限边界、会话生命周期、持久化恢复、消息发送和错误透传。
- 不重复测试依赖库已有的协议解析、命令匹配、模型元数据等行为，不为假设场景堆积测试或增加生产代码封装。
- 使用 `bun test` 运行测试，使用 `bun run check` 检查类型。

# 文档

pi-durable: https://github.com/earendil-works/pi/blob/main/packages/durable/README.md

pi-ai: https://github.com/earendil-works/pi/blob/main/packages/ai/README.md

pi 模型配置: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models-configuration.md

grammy: https://grammy.dev/guide/

pi-mcp: https://github.com/earendil-works/pi/blob/main/packages/mcp/README.md

MCP 与 codemode 示例: https://github.com/earendil-works/pi/tree/main/packages/agent/examples/mcp-codemode

Durable MCP 工具映射参考: https://github.com/earendil-works/pi/blob/main/apps/p2/plugins/mcp/tools.ts

多入口会话接入参考: https://github.com/earendil-works/pi/blob/main/apps/p2/plugins/discord/worker.ts

会话 API 示例: https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/07-harness-conversations.ts
