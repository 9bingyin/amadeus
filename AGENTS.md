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
- 基础工具直接安装官方 `createCodingTools`（`read`、`write`、`edit`、`bash`），通过 `NodeExecutionEnv` 执行，图片读取和接收共享同一个官方 Photon 处理器，不为接入重复创建实例。默认工作目录是 `$AMADEUS_HOME/workspace`，可用 `workspace` 覆盖，配置中的相对路径按应用 HOME 解析；工作目录由原生 agent `cwd` 保存，不自行实现工具调度、取消或恢复。工具具有当前用户的本机权限，工作目录不是沙箱。
- codemode 直接安装官方 `createCodemodeExtension` 和 `CodemodeSandbox`；按官方默认 `on` 模式保留基础工具的直接调用；脚本通过 `tools.*` 统一编排基础工具、MCP 和其他可调用工具，不作为 MCP 专用入口。声明、发现、store/load、嵌套调用及恢复日志均使用原生机制，不自行实现脚本执行或持久化；生命周期通过原生 `AsyncDisposableStack` 管理，按 Harness/storage → 沙箱 → MCP → 目录锁释放；保留共享的关闭 Promise，使并发 `close()` 都等待完整清理。
- MCP 使用官方 `@earendil-works/pi-mcp`，配置在 `mcpServers`；支持 stdio 和 Streamable HTTP，`env` / `headers` 直接填写，不展开环境变量引用。stdio 默认在 workspace 启动，显式 `cwd` 的相对路径按应用 HOME 解析。启动时连接并发现工具，不做 OAuth、配置热更新或自建重连；工具按官方命名、schema 和内容转换注册为 `callers: ["tools"]`、`deferred: true`，只通过 codemode 发现和调用。关闭顺序为 Harness → 沙箱 → MCP 连接 → 目录锁。
- 优先直接使用库的能力：grammY 负责命令匹配、过滤和中间件；pi-durable 负责会话、提交、任务、取消及恢复。不重复实现库已有的机制。
- Telegram 在现有授权私聊、`message` 更新范围内接收全部消息类型；先用原生 display-only `write` 保存当前消息完整字段并以 `requestId` 去重，不保存原始 update，回复、置顶及清单、投票、建议帖子、抽奖等字段中的其他消息，统一用原生 JSON replacer 收缩为 ID、时间与聊天引用，不递归保存，不迁移已有历史条目。普通内容进入 Agent，服务消息和命令只记录；服务消息不改变输入水位、收集窗口或正在输入状态，命令仍走独立处理逻辑。
- 入站时将发送者、Telegram 原始 UTC 时间、回复预览和转发来源封装进文本；非文本内容附类型元数据，不能原生输入的内容不伪装成已理解；模型输入只包含正文、必要元数据、附件清单和原生内容，不附加“未内联、请使用工具读取、尚未分析”等解释性说明或操作指引。使用 `defineTask` / `sleepUntil()` 固定窗口合批，默认 700ms，可通过 `channels.telegram.inputWindowMs` 配置，不随后续消息滑动；handler 不等待窗口或下载，每条消息的文本块在其对应图片块之前。
- 持久附件参考 p2：放在 `$AMADEUS_HOME/uploads/<conversationId>/<attachmentId>-<安全文件名>`，不放 workspace；目录 0700、文件 0600，临时写入后原子 rename，原名作展示，按文件字节识别 MIME，已完成文件恢复时复用。只下载当前内容的主附件：照片取最大尺寸，别名去重，缩略图、其他消息的附件和不可下载预览只保留元数据；实况照片保留静态图与视频。附件清单用原生 typed entry 与模型输入在同一事务保存，先 admission 后表写入，不另建文件索引数据库；`/new`、`/stop` 不删除已完成附件，不自动 TTL 清理。
- 批次收据统一保存在 task-scoped 文档中，首条不特殊存放，checkpoint 只记录阶段；收集结束后不再追加。批次按接收顺序提交，避免慢图片被后批消息越过；所有 `input` 均使用内容块数组，包括单条纯文本。运行中输入使用原生 `steer`，`steeringMode` / `followUpMode` 均为 `all`，不因补充消息抢占模型或工具。
- “正在输入”是非持久化状态：通过原生 `observeDoc` / `observeTaskGraph` 观察 Telegram 路由与未完成工作，按聊天和话题共享，立即发送并每 4 秒续期；空闲、取消或 Harness 关闭时停止并取消在途请求，重启按未完成工作恢复。状态请求不阻塞 Agent，失败只原样报告，不添加持久化 typing 任务。
- Telegram 工具进度使用原生 `ToolTask.beforeTool`，只展示顶层调用；codemode 用包裹图标并展示实际 code，不展开内部工具。沿用旧版工具图标、工具名和关键参数；多行空白合并，每条最多 60 个 Unicode 码点（含图标和省略号），保留最近 15 条，顶部标记省略。限制仅作用于展示，不限制实际参数、脚本、工具次数或 Agent 轮次；不展示工具输出，不把进度写进模型输入，Bot token 在截断前遮蔽。
- 工具进度静默发送、关闭链接预览，同一输入持续编辑一条消息，发送后恢复正在输入；使用原生提交观察中的 `LiveDoc.run` 判断结束，成功运行包含 afterRun 发送任务，因此最后一段回复发完才清理，停止和重置也清理。行列表为瞬时 UI 状态，原生 conversation Doc 仅保存外部消息引用，重启清理已知旧消息，不重放通知或工具；Telegram 请求异步串行且不阻塞工具与回答，关闭时取消并等待收尾，失败仅原样报告，不新增重试循环。
- 成功回复通过 `GenerationTask.afterRun` 返回 `runEndTask`，发送属于当前运行，不维护额外发送链。目标和输入来源水位存于 typed entry；按本轮最新已接纳输入选择来源，在进入发送阶段的原子检查点抑制过时回答及错误，开始发送后不追溯撤回。
- 失败通知依据 submission 结算结果持久化处理，不能只依赖 `afterRun` 或瞬时监听；入站准备错误保留原始报告。图片使用官方 Photon 及模型图片限制；模型不支持视觉或格式无法处理时仍提供原件路径和元数据，不把语音、视频或 PDF 当成原生模型输入，不自动转写或转换。带 Bot token 的下载地址不进入记录或模型输入；已知模型继承官方能力，自定义模型可用 `providers.<id>.models[].input` 声明 `text` / `image`。
- 命令绕过收集窗口，只有参数校验通过的 `/stop`、`/new` 记录处理收据，其原生取消范围包含收集、下载及发送任务；只读命令和参数错误不持久化去重，重复 update 可以重复回复。普通命令回执直接使用 `ctx.reply()`，不保证崩溃后补发；收据不代表命令副作用原子执行，Telegram 发送也不承诺严格 exactly-once。
- 只实现当前需求，尽量减少封装、抽象、兼容逻辑和防御性分支；但保留权限、数据保护和存储单写者等必要安全边界。
- 类型断言（`as`）和非空断言（`!`）优先通过类型收窄消除；确需保留时，在使用处注释说明库的兼容问题或成立的流程前提，不堆叠冗余运行时检查。

# 错误处理

- 当前阶段直接输出原始错误对象或上游错误内容，保留堆栈和附加字段；不包装错误，不替换成通用失败提示，不自行添加错误文案。
- 尽量不手写 `throw new Error`，不为流程自身已保证存在的会话、路由、输入记录添加重复检查。
- 底层库负责的校验交给底层；必要的配置校验统一使用 Zod，直接输出原始 `ZodError`。
- `catch` 仅用于必要的资源释放、正常取消处理或原样输出、重抛错误；不吞掉真实异常。入站准备仅捕获附件下载、识别和图片处理错误，不把事务提交或框架异常转换成普通输入失败。正常停止和重置不视为错误。

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
