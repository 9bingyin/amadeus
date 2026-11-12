# 项目约定

- 坚持简洁设计：除非有明确需求，不为 Agent 循环引入固定调用次数、超时、重试、Token、费用或轮次等人为限制。
- 使用 Bun + TypeScript，以 pi-durable 作为 Agent 运行框架。
- 使用 flake-parts + direnv 管理开发环境（`use flake`）。
- 使用 treefmt 统一格式化：`nix fmt`；`nix flake check` 检查格式、安装包运行冒烟和 NixOS 模块求值。包入口为 `packages.amadeus` / `packages.default`，用 `nix build .#amadeus` 构建；模块入口为 `nixosModules.amadeus` / `default`。`nix/package.nix` 通过 Bun 冻结锁文件的生产依赖固定输出构建，保留源码、worker/WASM 和 IPC 客户端相对路径，不做会破坏资源加载的单文件编译，不打包本地数据或开发依赖。包元数据遵循 nixpkgs 的单行事实描述、主页、许可证、维护者、平台和 mainProgram 约定。NixOS 模块沿用默认 root、可指定现有 user 和 extraPackages；工具具有该用户完整权限，不增加文件系统沙箱。仅提供运行时 configFile，使用 systemd LoadCredential 私密加载，状态 HOME 固定 /var/lib/amadeus，不生成含凭据的 store 配置，不提供 settings 或旧版 environmentFile/环境变量凭据替换。
- `.test_home/` 保留旧实现的本地数据，不提交 Git；未经明确要求，不修改或迁移其中的数据。
- `AMADEUS_HOME` 指定应用主目录，未设置或为空时默认 `~/.amadeus`；相对路径按启动时的当前目录解析。默认读取其中的 `config.json`，命令行可指定其他配置文件，但不改变状态目录；配置中不另设 `stateDirectory`。
- 凭据直接填写在 `config.json` 的 `channels.telegram.token` 和 `providers.<id>.apiKey`，不提供凭据环境变量映射或回退；`AMADEUS_HOME` 仅负责目录选择。
- HOME 中的 `session.sqlite` 保存 pi-durable 数据，`amadeus.lock` 使用非阻塞 `flock` 保证单写者；先取得锁再打开存储，先关闭 Harness 再释放锁，不删除锁文件，不另建锁数据库。

# 实现规范

- 以当前依赖的官方文档和推荐接口为准，不照搬旧实现，不为兼容旧架构添加适配层。
- 按功能划分目录：`src/config/` 负责配置，`src/agent/` 负责 Agent 与模型，`src/channels/` 是接入层，其中 `telegram/` 负责 Telegram 对接；`src/main.ts` 只负责组装和启动。
- 配置按 pi coding agent 分层：`agent` 只放原生模型引用 `{ provider, modelId }` 和 `thinkingLevel`；`providers` 按 provider ID 保存连接、凭据、`models` 与 `modelOverrides`。`src/agent/providers.ts` 只组装官方 provider 与 API，不重写协议或认证流程；仅注册显式配置的 provider，凭据与 headers 按字面值使用，不执行命令或展开变量。内置目录保留聊天、分类与图像模型，自定义聊天协议支持 Responses、Chat Completions、Anthropic Messages 和 Google Generative AI。自定义模型继承同 ID 的已知元数据，未知模型必须填写 contextWindow/maxTokens，不猜测上下文或输出能力；modelOverrides 只修改已知条目，嵌套能力字段按 pi 规则合并，不另加运行限制。
- 用户消息接入配置放在 `channels.<平台>`，缺省表示不启用，至少配置一个已实现的用户消息接入。内部 IPC 通知接入默认启用，不新增配置，也不自行创建用户会话。接入各自负责鉴权、外部路由、消息封装和入出站任务，通过原生 Conversation API 使用共享 Harness；不提前统一跨平台用户 ID 或合并会话，不引入通用消息总线或接入 Manager。公共接入层统一进程信号、Harness resume 与所有接入的停止收尾；平台只实现 `run(signal)`，不得关闭共享 Harness。平台目录重构不改持久化的文档、任务 kind 或 requestId。
- system prompt 的固定规则放在 `src/agent/prompt.ts`，身份在启动时从 `$AMADEUS_HOME/SOUL.md` 读取，只替换 preamble；缺失或空白时使用 `You are a personal assistant inside pi durable, an agent harness.`，其他读取错误原样抛出，修改后重启生效。不扫描 workspace/SOUL.md，不提供身份路径或 `instructions` / system prompt 配置，不从 SYSTEM.md 加载整段替换文本。通过 Durable 原生 `defineExtension` / `section` 组装，不注入 Pi 文档提示或文档路径，也不依赖打包 Pi 文档。工具声明、codemode、MCP 和 skills 沿用各自原生模块，不手写重复的工具声明；cwd 由原生 ExecutionEnv 提供。应用配置用原生 `instructions: null` 清除旧会话保存的 instructions，提示差量、历史和重启继续由 Durable 管理，不自行迁移会话或重写 prompt 历史。不提前恢复旧版尚未实现的模块。
- `<system>` 通过原生 section 提供宿主平台、内核版本、架构、Linux 发行版和时区；操作系统信息使用 node:os，os-release 使用原生 parseEnv，时区名称和当前 UTC 偏移使用 Intl，不执行探测命令或另加依赖，不每轮注入时钟时间。平台说明统一在单一 `<platform>`：共享通知扩展安装原生 platform section 提供 `<ipc>` 入站报告说明，Telegram 接入通过原生 wrapSection 在所属会话前置 `<telegram>`，以 TelegramState 路由归属限定，不得覆盖 IPC 说明或泄漏到其他会话。不另设 `<notifications>` section；IPC CLI 说明仅在当前会话选择 amadeus.ipc 扩展时附在 `<ipc>` 内，接入停止后仍保留已接纳报告的说明。Telegram 只说明当前消息头、UTC、回复/转发元数据、结构化内容、已保存附件与原生图片、send_file、普通 Markdown 和语言，不照搬旧实现的附件能力或排版限制，不声称存在 local 等尚未实现的能力。
- AGENTS 上下文复用官方 `loadProjectContextFiles({ agentDir: stateDirectory, cwd: workspace })`，沿用 HOME 全局规则、workspace 祖先到当前目录的发现顺序、同目录 override/文件别名优先级、去重与诊断，不创建 DefaultResourceLoader 或包 Manager；通过原生 `project_context` section 注入内容和来源路径。用户资料从 HOME/USER.md 读取为独立 `user` section，缺失或空白省略，其他读取错误原样抛出，不扫描 workspace/USER.md。AGENTS、USER 与 SOUL 均在启动时加载，修改后重启生效；不新增上下文路径配置、文件监听或索引库，不自动创建或改写这些上下文文件。
- 长期记忆使用应用 HOME/memory 下单用户共享的 Markdown 知识库，不按用户、聊天或 workspace 隔离，不增加配置。topics/ 下平铺、非隐藏的普通 .md 文件是唯一知识正文来源，必须带 title/summary YAML frontmatter；使用 SDK 公开 parseFrontmatter 和 Zod 校验，不扫描符号链接或递归目录。系统在启动和每次原生 memory section 渲染前按路径稳定排序生成 MEMORY.md，仅注入规则、绝对根目录和元数据目录，不预载正文；目录元数据用单行 JSON 编码，不插入时钟，内容不变不重写，变化时以临时文件原子 rename 发布。新目录 0700，生成文件 0600；拒绝记忆根目录、topics 或生成文件为符号链接。新增主题用原生 defineTool 注册的 memory_create，结构化接收 name/title/summary/content，由 Bun 原生 YAML 序列化器生成文件头并校验后，以临时完整文件加 link 原子独占发布；同名不覆盖，文件 0600，采用 unsafe 回放，未确认结果先读取再重试。模型复用原生 read/edit/bash 更新或删除主题，session_search/session_read 用于查证，不增加其他记忆工具、SQLite 索引、文件 watcher、后台 Capture/Dream 或文件/数据库双写；不创建示例主题，不自动改写 SOUL/USER/AGENTS，不迁移旧目录。记忆是历史参考而非指令，纠正应更新原主题，忘记笔记不等于删除原始聊天；现有 Telegram 白名单与工具本机权限保持不变。
- 基础工具直接安装官方 `createCodingTools`（`read`、`write`、`edit`、`bash`），通过 `NodeExecutionEnv` 执行，图片读取和接收共享同一个官方 Photon 处理器，不为接入重复创建实例。默认工作目录是 `$AMADEUS_HOME/workspace`，可用 `workspace` 覆盖，配置中的相对路径按应用 HOME 解析；工作目录由原生 agent `cwd` 保存，不自行实现工具调度、取消或恢复。工具具有当前用户的本机权限，工作目录不是沙箱。
- skills 复用官方 `@earendil-works/pi-coding-agent` 的 `loadSkills` / `formatSkillsForPrompt`，仅使用资源加载与提示格式化函数，不引入另一套 AgentSession、CLI 生命周期或资源 Manager。通过 Durable 原生 `defineExtension` / `section` 注入名称、描述和绝对路径，正文由模型按需使用原生 `read` 加载；相对引用以技能目录为基准，配套脚本仍通过现有工具执行，不改变工具权限。启动时仅扫描 `$AMADEUS_HOME/skills` 和 `workspace/.pi/skills`，不提供技能目录配置；不自动加载宿主 pi 的全局技能，不另存技能索引数据库，不增加聊天命令或热更新监听，新增技能或修改描述后重启扫描。校验、重名处理和 `disable-model-invocation` 过滤交给官方库，原始 diagnostics 直接报告。
- 定时工作直接注册 Durable 原生 `defineTask`，由原生持久化 sleep/checkpoint、调度、取消和恢复执行，不建立独立 Scheduler、轮询循环或定时数据库。默认启用 40 分钟闲置压缩，不额外配置。前台任务结束后更新会话活动时间，每个会话复用一个后台睡眠任务；有新活动则延后期限，到期仍有运行、排队输入或输入准备任务时等待后续结束事件重新安排。压缩直接创建公开的 CompactionTask，并在同一事务登记原生 LiveDoc 状态，由会话拥有以沿用写提交与安全边界，不把它挂成定时任务的阻塞子任务；沿用原生近期上下文保留策略、短上下文跳过、用量、错误、取消与恢复，不删除原始历史。启动按公开 GenerationTask 结束记录补齐未保存的活动，已有期限不因重启推迟，已检查的闲置阶段不反复压缩；不为无模型的内部控制会话安排压缩，活动观察在 Harness 关闭前解除并等待已排入的提交。
- 定时工作使用单一 `schedule` 原生工具，公共提示段为 `<scheduled>`，只描述执行与报告约定，参数细节交给工具 schema；action 为 create/list/enable/disable/delete，参数按动作使用原生 union schema 校验；工具整体采用 unsafe 恢复，中断后先 list 确认结果再重试变更，查询中断可重新查询。支持固定间隔 every、Cron 日历表达式和一次性 at/after；一次性日期带 UTC 偏移，延迟和间隔按宿主时钟计算。Cron 仅使用 cron-parser 的公开解析与 next API 计算下一次绝对时间，实际等待、执行、取消与恢复仍交给 Durable；表达式支持五字段及可选秒字段，timezone 在创建时显式保存，缺省取 Intl 的宿主时区，不因重启改变，夏令时交给原库，H 字段使用稳定 hashSeed。不增加额外重试或运行限制。计划清单和归属以文件为唯一来源，不建立 Schedules/Host 业务 Doc 或其他数据库目录；接收会话由宿主写入元数据且固定，不接受模型指定收件人。控制器位于独立无模型 Conversation 的后台任务中，原生子 Task 执行脚本或驱动独立 Worker 的 Agent Loop，因此聊天的 /stop、/new 不取消计划，使用 disable 完成本次后暂停，delete 取消当前工作并标记删除。命令通过当前 ExecutionEnv.exec 执行，cwd 在创建时按原生环境解析后写入计划 JSON，手工修改的相对路径以 plan.json 所在目录解析，不是沙箱；stdout/stderr 分开写入 HOME/schedules/<计划 UUID>/runs/<原生运行 TaskId> 的 0700/0600 日志，拒绝日志目录符号链接，运行不截断已有日志。脚本执行前持久化中断栅栏，已开始但未保存结果的命令恢复后报告 interrupted 并终止计划，不自动重跑；正常取消不通知。成功只在 stdout 含非空白内容时通知，stderr 仅为日志；非零退出、原生执行错误和任务故障保留原始内容并通知。周期任务串行，错过时段合并为一次；固定间隔按原时间轴计算下一次，Cron 按不早于本次计划时间的当前时刻计算下一个匹配点；确定的命令失败可到下一周期，未知结果不继续执行。结果与通知 Task 创建同事务提交，复用共享 NotificationTask 的持久化 followUp 和 Telegram 输出来源；通过通知的可选 metadata 接口注入 source="schedule"、scheduleId/name/runId/runner，执行结果保留在 data，不把来源字段重复塞进正文。管理操作按文件中的原生会话归属鉴权；默认 list 隐藏删除项，includeDeleted 或指定 ID 可查看。delete 先原子写删除标记，再原生取消控制器及运行中的工作并等待终态，保留全部文件、收据和日志；删除为终态，不允许 enable 或 disable 恢复。普通 bash/stdout 与显式 IPC 行为保持不变。
- 定时计划实现集中在 `src/agent/schedule/`。计划 ID 是独立 UUID，不使用 Durable TaskId。HOME/schedules/<UUID>/plan.json 保存 name、command 或 prompt、cwd、when，Agent 计划还保存模型、思考等级、扩展和工具选择；meta.json 保存宿主生成的 owner、enabled/disabled/deleted 三态、创建/启用时间、activation 和 registered 登记确认，均以文件为唯一业务来源。数据库只保存原生控制器/子任务及 checkpoint、Worker 配置/历史、通知和完成决定等执行记录，不保留业务目录或配置回退，也不另存权威 nextAt/lastRun 文件。文件用 Zod 校验，目录 0700、JSON 0600；新目录独占创建，完整临时文件加 link 发布，meta.json 最后发布作为完整标记，元数据变更以临时完整文件原子 rename。拒绝根目录、计划目录或 JSON 符号链接和非普通文件。启动在所有接入 run 已启动后、Harness resume 前扫描 UUID 目录，并按原生输入中的 planId/activation 对账；registered=false 的新启用意图可登记，已确认却缺失原生记录时拒绝自动重跑。无轮询、watcher 或旧版兼容/导出/迁移。列表读取文件并补充原生状态，控制器和运行记录按请求批量分页扫描并以 planId 分组，只保留所需的最新运行；启动恢复使用操作期间的临时分组视图，一次扫描并通过原生提交观察更新，成功或失败结束后立即解除观察，不逐计划重复全量扫描、不增加常驻缓存或数据库索引。每次执行前及下一次排期前重读定义，不中断当前运行或重排已有 sleep，保持 Script/Agent 类型。一次性计划的实际运行结算（含明确失败或中断）后自动软删除，不清理文件、日志或历史；通知与原生 finish checkpoint 同事务提交，随后按当前 activation 写 deleted 并结算控制器，重启只补文件状态，不重复执行或创建通知。旧激活的收尾不得覆盖已重新启用的新激活；禁用未触发的一次性计划不自动删除，禁用已接纳的一次则完成报告后仍自动删除。启动按当前激活的原生完成收据补齐尚未写入的删除标记，不依赖文件 watcher 或查询副作用。禁用周期计划允许已接纳的一次完成和报告，之后暂停；再启用增加 activation，新的控制器通过原生 allSettled 等待所有旧运行结束，不并发执行。每计划仅有进程内串行临界区协调文件状态与原生提交，取消和等待在锁外执行。删除标记在通知提交前生效时抑制通知，已经接纳的独立通知不撤回。定义无效时保留原始错误并停止原生运行，仍可通过独立元数据禁用或删除；不修改 .test_home 或 .amadeus_test_new 数据。
- `schedule` 创建参数以原生 union schema 接收互斥的 command/prompt：command 保留脚本协议，prompt 启动原生 Agent Loop。每个启用阶段复用一个由控制器 Task 拥有的 Worker Conversation，首次创建时将调用方 model/thinking/cwd 和选中的扩展、工具保存到文件，不复制主聊天历史；禁用后再启用由新控制器拥有原生历史 fork，保留旧 Worker，不在终态任务下创建新拥有关系；通过 section 注入 Worker 身份和完成规则，不设置 instructions。每次周期由原生 RunAgent Task 从 JSON 读取当前 prompt 和执行选择，用稳定 requestId 向同一 Worker 提交完整任务；重新应用文件配置、提交和保存 submission ID checkpoint 在同一事务中完成，恢复等待阶段只接续已接纳的提交，不用改后的文件替换正在运行的任务。等待 submission 结算与 waitForIdle 收尾后持久化结果，不为模型/工具另写执行循环，不套脚本中断栅栏。普通最终回答直接结束本次原生 Loop，未提交报告决定时按 notify=false 静默成功结算，不通过 onYield 强制续跑或补完成收据。可选的原生 schedule_result 工具是 deferred、model-only、safe，只在 Worker 中显式加载并校验活动运行归属，以任务 Doc 保存首次 notify=false 或 notify=true/message 决定，用 control.terminate 结束；只有显式 notify=true 的成功结果才报告，显式 notify=false 也可提前静默结束。不自行解析 JSON 或添加轮次限制。主会话仍只提供 schedule，codemode 不可嵌套调用完成工具。Worker 按完整 tools/extension 选择排除 schedule、send_file 和 Telegram/IPC/通知扩展，不能只用 modelTools 隐藏；工作目录仍不是沙箱。静默完成不创建 NotificationTask，也不调用主模型；需要报告时沿用同事务通知与 followUp，正常取消不报告，最终失败保留原生结算 reason/detail。Worker 原始历史保留，list 返回 worker、prompt 和最近原生运行结果，Agent 不伪造脚本日志路径；delete 写入删除标记后沿原生拥有关系取消 Worker、当前运行和工具，不移除计划文件，也不硬删会话或历史。
- 本地 IPC 位于 `src/channels/ipc/`，由 openChannels 打开，通过 `run(signal)` 统一停止并等待在途请求，Agent 不启动或关闭 Socket。接入安装原生 extension / wrapTool，以官方 createBashTool.prepare 注入命令凭据；通知 Task / Entry 和 formatNotification 位于 `src/channels/notifications.ts`，平台消息说明位于 `src/channels/ipc/prompt.ts`，由 Agent 安装共享 extension，供定时工作与 IPC 复用；Notification 的可选 metadata: JsonObject 是宿主生产方注入来源信息的接口，IPC 宿主固定 source="ipc"，客户端不得提交 metadata 或指定收件人；通知任务在提交线外解析 Agent 后再调用事务内 admitted 钩子。停止 IPC 时卸载入口提示和 bash 包装，不卸载共享通知定义，也不关闭 Harness。openChannels 初始化失败时收尾已打开的接入，runChannels 在 resume 前启动所有接入的 run，以保证 resume 失败也会收尾。本地 IPC 使用 Bun Unix Socket，不监听 TCP；持锁宿主启动 `$AMADEUS_HOME/ipc/notify.sock`，目录 0700、Socket 0600。先绑定随机临时路径，再用 link 独占发布并移除临时名字，避免 Bun.stop 直接 unlink 公开路径的替换文件；应用关闭只按原 inode 清理，旧路径仅允许清理真实 Socket，拒绝普通文件和符号链接。通过官方 createBashTool.prepare 给每条命令注入 AMADEUS_NOTIFY_SOCKET/TOKEN/CLI，凭据只保存 task-scoped hash 与启动 epoch，命令结束、取消或应用重启后失效；不把凭据放进提示或回执。脚本显式调用 `bun run "$AMADEUS_NOTIFY_CLI" --key ... --message ... [--data ...]`，普通 stdout 不另建通知。正文只接收 eventKey/message/data，目标固定为发放凭据的会话；在事务内重验原任务仍运行、按命令与事件 key 去重并创建原生 NotificationTask，202 只表示持久化接纳。任务用稳定 requestId 和 followUp 提交 typed entry，不抢占模型或工具；模型输入使用文本内容块，以 [IPC 星期 UTC时间] 或 [Schedule 星期 UTC时间] 开头，缺少已知来源时使用 [Notification 星期 UTC时间]；消息头不展示内部通知 ID 和源任务 ID，计划名称及业务 ID 保留在 metadata，依次附可选的单行 [Metadata: JSON]、[Data: JSON]，再保留原始正文，不使用 XML 包裹，不把 eventKey 等传输字段整包交给模型。时间采用原生任务首次开始时间，重启不改已提交输入；元数据和附加数据 JSON 中 `<` 转义，正文不转义或解析。通知整体是参考数据而非用户指令，IPC 事件不代表命令完成，原生 kind/requestId 和旧历史不迁移。Telegram 通过原生任务 admitted 钩子在同事务安排失败通知，钩子只用 tx；afterRun 优先保留用户输入来源，纯 IPC 回答按绑定和白名单路由，使用独立来源绕开用户输入水位，不伪造用户收据。客户端也可用 `bun run src/main.ts notify`，只连接现有宿主，不读取配置或另开 Harness。先关闭入口并等待在途处理，再关闭 Harness；不新增 Signal 替代实现或独立后台命令服务。
- 历史只提供 `session_read` / `session_search`，固定调用方 Conversation，不提供跨用户查询或会话管理。读取、索引来源使用 Durable 原生历史 API，保留 reset/compaction 前的用户和助手原文，排除 thinking、工具输出及生成的摘要。通过公开 SQLite facade 与 Durable 共享 `session.sqlite` 连接，应用专属 FTS5 trigram 表按查询增量补齐；索引和进度同事务，短于 3 个字符的查询用字面子串匹配，不做向量搜索、后台索引任务或另建数据库，不读取 Durable 内部 SQL 表。分页游标固定历史上界，不因查询自身新增消息追赶尾部；原生 safe 回放、取消和关闭机制不变。
- codemode 直接安装官方 `createCodemodeExtension` 和 `CodemodeSandbox`；按官方默认 `on` 模式保留基础工具的直接调用；脚本通过 `tools.*` 统一编排基础工具、MCP 和其他可调用工具，不作为 MCP 专用入口。声明、发现、store/load、嵌套调用及恢复日志均使用原生机制，不自行实现脚本执行或持久化；生命周期通过原生 `AsyncDisposableStack` 管理，按 Harness/storage → 沙箱 → MCP → 目录锁释放；保留共享的关闭 Promise，使并发 `close()` 都等待完整清理。
- MCP 使用官方 `@earendil-works/pi-mcp`，配置在 `mcpServers`；支持 stdio 和 Streamable HTTP，`env` / `headers` 直接填写，不展开环境变量引用。stdio 默认在 workspace 启动，显式 `cwd` 的相对路径按应用 HOME 解析。启动时连接并发现工具，不做 OAuth、配置热更新或自建重连；工具按官方命名、schema 和内容转换注册为 `callers: ["tools"]`、`deferred: true`，只通过 codemode 发现和调用。关闭顺序为 Harness → 沙箱 → MCP 连接 → 目录锁。
- Telegram 的 `send_file` 参考 p2 官方 send-file/tool.ts，以原生 `defineTool` 注册，直接和 codemode 均可调用；仅按调用会话的原生 TelegramState 路由发送到当前私聊/话题，执行时校验 Bot 绑定和白名单，不接受模型提供收件人。默认 document 发送原始文件，可选 photo，caption 为纯文本；10/50 MiB、caption 1024 字符是 Telegram 协议限制，不是 Agent 限制。通过当前 `ExecutionEnv.openBinaryReader` 流式读取普通文件、grammY InputFile 上传，路径按原生 cwd 解析，不把 workspace 当沙箱，不另存发送快照、队列或索引库；保留原生文件错误和 Telegram 错误。外部发送采用原生 `replay: "unsafe"`，未确认结果的调用重启后不自动重发，已完成 codemode 嵌套结果沿用原生日志；上传仅用官方 autoRetry 处理明确的 retry_after，网络错误与 5xx 原样抛出，避免不确定结果自动重传，不承诺 exactly-once。发送前停止并等待在途草稿，成功后刷新 typing；取消或关闭使用原生工具 Context，finally 无取消地关闭 reader。
- 优先直接使用当前版本库公开的原生能力：pi-durable 负责 Agent 循环、会话、提交、任务、工具执行、取消及恢复，grammY 负责 Telegram API、命令、过滤和中间件；其他能力优先复用兼容的 pi 生态、官方插件及标准库。不复制框架内部运行机制，不通过私有导入或另一套 AgentSession / ResourceLoader / ModelRuntime 拼装替代运行时。应用只保留配置映射、鉴权/路由、平台展示和必要业务状态；复用必须保留现有权限、错误透传、取消及恢复语义，不能仅为减少代码换成行为不等价的插件。新增功能先核对当前版本公开接口和示例，没有可用原生实现时才写最小适配。
- Telegram 在现有授权私聊、`message` 更新范围内接收全部消息类型；先用原生 display-only `write` 保存当前消息完整字段并以 `requestId` 去重，不保存原始 update，回复、置顶及清单、投票、建议帖子、抽奖等字段中的其他消息，统一用原生 JSON replacer 收缩为 ID、时间与聊天引用，不递归保存，不迁移已有历史条目。普通内容进入 Agent，服务消息和命令只记录；服务消息不改变输入水位、收集窗口或正在输入状态，命令仍走独立处理逻辑。
- 入站时将发送者、Telegram 原始 UTC 时间、回复预览和转发来源封装进文本；非文本内容附类型元数据，不能原生输入的内容不伪装成已理解；模型输入只包含正文、必要元数据、附件清单和原生内容，不附加“未内联、请使用工具读取、尚未分析”等解释性说明或操作指引。使用 `defineTask` / `sleepUntil()` 固定窗口合批，默认 700ms，可通过 `channels.telegram.inputWindowMs` 配置，不随后续消息滑动；handler 不等待窗口或下载，每条消息的文本块在其对应图片块之前。
- 持久附件参考 p2：放在 `$AMADEUS_HOME/uploads/<conversationId>/<attachmentId>-<安全文件名>`，不放 workspace；目录 0700、文件 0600，临时写入后原子 rename，原名作展示，按文件字节识别 MIME，已完成文件恢复时复用。只下载当前内容的主附件：照片取最大尺寸，别名去重，缩略图、其他消息的附件和不可下载预览只保留元数据；实况照片保留静态图与视频。附件清单用原生 typed entry 与模型输入在同一事务保存，先 admission 后表写入，不另建文件索引数据库；`/new`、`/stop` 不删除已完成附件，不自动 TTL 清理。
- 批次收据统一保存在 task-scoped 文档中，首条不特殊存放，checkpoint 只记录阶段；收集结束后不再追加。批次按接收顺序提交，避免慢图片被后批消息越过；所有 `input` 均使用内容块数组，包括单条纯文本。运行中输入使用原生 `steer`，`steeringMode` / `followUpMode` 均为 `all`，不因补充消息抢占模型或工具。
- “正在输入”是非持久化状态：通过原生 `observeDoc` / `observeTaskGraph` 观察 Telegram 路由、前台工作及 Telegram 后台收发任务，后台维护与定时睡眠不显示 typing，按聊天和话题共享，立即发送并每 4 秒续期；空闲、取消或 Harness 关闭时停止并取消在途请求，重启按未完成工作恢复。状态请求不阻塞 Agent，失败只原样报告，不添加持久化 typing 任务。
- Telegram 工具进度使用原生 `ToolTask.beforeTool`，只展示顶层调用；codemode 用包裹图标并展示实际 code，不展开内部工具。沿用旧版工具图标、工具名和关键参数；多行空白合并，每条最多 60 个 Unicode 码点（含图标和省略号），保留最近 15 条，顶部标记省略。限制仅作用于展示，不限制实际参数、脚本、工具次数或 Agent 轮次；不展示工具输出，不把进度写进模型输入，Bot token 在截断前遮蔽。
- 工具进度静默发送、关闭链接预览，同一输入持续编辑一条消息，发送后恢复正在输入；使用原生提交观察中的 `LiveDoc.run` 判断结束，成功运行包含 afterRun 发送任务，因此最后一段回复发完才清理，停止和重置也清理。行列表为瞬时 UI 状态，原生 conversation Doc 仅保存外部消息引用，重启清理已知旧消息，不重放通知或工具；Telegram 请求异步串行且不阻塞工具与回答，关闭时取消并等待收尾，失败仅原样报告，不新增重试循环。
- Telegram 最终正文按普通 Markdown 解析，用 `telegram-md-entities` 转为原生 text/entities 并按 Telegram 长度、实体预算安全分段，不手写 Markdown 转义或强制模型输出 MarkdownV2；保持 CommonMark 的双下划线加粗语义。发送检查点保存格式化后的分段，旧的纯文本检查点继续原样发送，不迁移历史。命令、工具进度和原始错误保持纯文本。
- `channels.telegram.streaming` 默认 false。启用后仅观察原生 `LiveDoc.generation.message` 的正文，通过 `sendMessageDraft` 显示临时 Markdown 草稿，不输出思考或工具调用，不新增 Agent 循环或轮次限制；路由用原生 `observeDoc` 绑定，沿用 Durable 原生进度节流并合并在途更新，取消直接按原生 ConversationId 定位，不另建路由队列。草稿只预览 Telegram 单条消息可容纳的首段，完整最终回复仍由原生 delivery 任务持久化分段发送；正式发送前取消并等待在途草稿。UI 观察与输出生命周期使用原生 DisposableStack / AsyncDisposableStack，启动失败也释放已取得的订阅，保持共享 Harness 的所有权不变，并发 close 共享同一个清理 Promise。新输入水位、停止、重置和关闭会停止旧草稿更新，临时草稿由正式消息替换或 Telegram 自动过期，不保存额外草稿数据库，不重放草稿；原始草稿错误只报告一次当前生成尝试，最终回复不受影响。
- 成功回复通过 `GenerationTask.afterRun` 返回 `runEndTask`，发送属于当前运行，不维护额外发送链。目标和输入来源水位存于 typed entry；用户运行按本轮最新已接纳用户输入选择来源，纯 IPC 通知运行使用宿主路由且不改动用户水位，在进入发送阶段的原子检查点抑制过时回答及错误，开始发送后不追溯撤回。
- 失败通知依据 submission 结算结果持久化处理，不能只依赖 `afterRun` 或瞬时监听；入站准备错误保留原始报告。图片使用官方 Photon 及模型图片限制；模型不支持视觉或格式无法处理时仍提供原件路径和元数据，不把语音、视频或 PDF 当成原生模型输入，不自动转写或转换。带 Bot token 的下载地址不进入记录或模型输入；已知模型继承官方能力，自定义模型可用 `providers.<id>.models[].input` 声明 `text` / `image`。
- 命令绕过收集窗口，只有参数校验通过的 `/stop`、`/new`、`/compact` 记录处理收据；停止和重置的原生取消范围包含收集、下载、压缩及发送任务。`/compact` 仅非阻塞提交公开 Conversation.compact，不中断当前运行，不等待摘要；短上下文跳过、摘要放置、恢复和取消交给 Durable，固定命令回执、菜单、帮助和查询展示使用简短英文，不改变工具进度或原始错误。`/status` 用 `Context: 27.6%/500k` 展示当前有效上下文而非累计用量，窗口取共享 Models 的当前模型元数据，估算复用 pi-ai 公开 estimateContextTokens 与 Durable Conversation.context；重置或压缩后，没有 head 之后的有效提供方用量时显示 `?/窗口`，窗口未知显示 `?/?`，不复用旧比例，不启动模型或另存用量状态。空闲时省略零值，仅在有工作或错误时显示收集、排队、压缩数量和最近原生错误。`/schedule` 只读取当前聊天/话题的计划目录和原生任务状态，仅按归属和 deleted 状态过滤，不额外按原生执行终态隐藏；完成、取消和失败的执行结果分别显示 Completed/Stopped/Failed，查询不改写 enabled/disabled/deleted，不调用模型、不改写目录；回复使用纯文本并按 Telegram 协议分段。只读命令和参数错误不持久化去重，重复 update 可以重复回复。普通命令回执直接使用 `ctx.reply()`，不保证崩溃后补发；收据不代表命令副作用原子执行，Telegram 发送也不承诺严格 exactly-once。
- 只实现当前需求，尽量减少封装、抽象、兼容逻辑和防御性分支；但保留权限、数据保护和存储单写者等必要安全边界。
- 类型断言（`as`）和非空断言（`!`）优先通过类型收窄消除；确需保留时，在使用处注释说明库的兼容问题或成立的流程前提，不堆叠冗余运行时检查。

# 运行日志

- 关键生命周期、Telegram 收发、原生模型请求与压缩、计划执行和通知接纳使用英文 `console.info` 直接输出到终端；只附必要的会话、任务、消息标识及原生状态，不记录消息正文、工具参数、脚本、报告或凭据。不引入日志框架、包装、级别配置、JSON 格式、时间前缀或日志落盘；现有计划脚本 stdout/stderr 文件保持原有用途。错误和上游诊断继续原样 `console.error`，不翻译、字符串化、替换或另包错误对象；IPC CLI 的机器可读 stdout 不加入运行日志。

# 错误处理

- 当前阶段直接输出原始错误对象或上游错误内容，保留堆栈和附加字段；不包装错误，不替换成通用失败提示，不自行添加错误文案。
- 尽量不手写 `throw new Error`，不为流程自身已保证存在的会话、路由、输入记录添加重复检查。
- 底层库负责的校验交给底层；必要的配置校验统一使用 Zod，直接输出原始 `ZodError`。
- `catch` 仅用于必要的资源释放、正常取消处理或原样输出、重抛错误；不吞掉真实异常。入站准备仅捕获附件下载、识别和图片处理错误，不把事务提交或框架异常转换成普通输入失败。正常停止和重置不视为错误。

# 测试

- 只保留必要的应用层测试，重点覆盖权限边界、会话生命周期、持久化恢复、消息发送和错误透传。
- 不重复测试依赖库已有的协议解析、命令匹配、模型元数据、codemode 内部状态机等行为，不为假设场景堆积测试或增加生产代码封装。不以普通日志措辞、完整工具顺序等实现快照代替行为断言；只在日志隐私、协议、权限或去重本身是契约时断言对应内容和次数。
- 测试名称、注释和普通示例使用简短英文；中文和其他 Unicode 样本只用于验证检索、转义、实体偏移、文件名与原文保真。按单一可观察行为命名，保留最小必要准备，不为减少测试数量把无关场景合并成大测试。
- 使用 Bun 原生测试 API 和类型安全的 stub/spy；异步调用完整 await，在 finally/afterEach 恢复全局状态、spy 并关闭临时文件、Socket、订阅和子进程。定时与并发优先使用 Durable 原生时钟和提交事件/Promise 门闩，不用重试掩盖失败，不依赖测试顺序。
- TypeScript 配置遵循 Bun 官方推荐，保留额外的 `exactOptionalPropertyTypes`；当前仅有 TypeScript 后端，不启用 JSX 或 allowJs。使用原生 `bun test` 运行测试、`bun check` 检查类型，不另设同名脚本。

# 文档

Bun 测试: https://bun.com/docs/test/writing-tests

Bun mocks 与清理: https://bun.com/docs/test/mocks

Bun 测试运行时与隔离: https://bun.com/docs/test/runtime-behavior

pi-durable: https://github.com/earendil-works/pi/blob/main/packages/durable/README.md

pi-ai: https://github.com/earendil-works/pi/blob/main/packages/ai/README.md

pi 模型配置: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models-configuration.md

grammy: https://grammy.dev/guide/

pi-mcp: https://github.com/earendil-works/pi/blob/main/packages/mcp/README.md

MCP 与 codemode 示例: https://github.com/earendil-works/pi/tree/main/packages/agent/examples/mcp-codemode

Skills SDK 示例: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/04-skills.ts

Skills 约定: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md

AGENTS 上下文示例: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/07-context-files.ts

Durable 原生提示段示例: https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/14-system-prompt.ts

Durable 文件发送工具参考: https://github.com/earendil-works/pi/blob/main/apps/p2/plugins/send-file/tool.ts

grammY 文件上传: https://grammy.dev/guide/files#uploading-your-own-files

Durable MCP 工具映射参考: https://github.com/earendil-works/pi/blob/main/apps/p2/plugins/mcp/tools.ts

多入口会话接入参考: https://github.com/earendil-works/pi/blob/main/apps/p2/plugins/discord/worker.ts

会话 API 示例: https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/07-harness-conversations.ts
