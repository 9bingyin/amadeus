# Pi 0.84.4 插件与 RPC 审计

审计日期：2026-09-04

基线提交：`2fc12e5e43c7af56f6f2cc503261e83e91316fa1`

主要修复提交：`e659fb48dd56d8d0f60165913fb809fef4b18e3c`

审计证据和复审整改：本文件所在的后续提交

Pi 版本：`0.84.4`

## 范围

本次审计检查以下代码：

- `plugins/memory/`
- `plugins/telegram/`
- `src/bridge/`
- `src/pi-rpc/`
- `src/app.ts` 和 `src/index.ts` 中的插件宿主 wiring
- Memory 和 Telegram 的生命周期、持久状态和资源清理

目标最初列出的 `src/pi-extension/` 在基线和当前仓库中都不存在。对应职责实际位于 `plugins/`、`src/bridge/chat-agent.ts`、`src/app.ts` 和 `src/pi-rpc/`。

以下内容不在范围内：Pi 升级、Pi 上游修改、Infra 修改、服务器部署、新插件功能和无关重构。

## 证据分类

本文使用三类证据：

- **明确规范**：Pi 0.84.4 文档直接规定的行为。
- **实现事实**：文档没有完整规定，但 Pi 0.84.4 的类型或运行时代码可以确认的行为。
- **Amadeus 协议**：项目自己的 Extension UI 载荷、持久去重、超时预算和非幂等结果规则。

文档路径以 Pi 0.84.4 发行包内的 `libexec/pi/` 为根。运行时代码路径以锁文件安装的 `node_modules/` 为根。

## 规范矩阵

| 检查项                    | 分类                    | Pi 0.84.4 依据                                                                                                                                                                                                                                                            | Amadeus 结论                                                                                                                                                       |
| ------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 字符串枚举 schema         | 明确规范                | `docs/extensions.md` 的 "Custom Tools" 和 "String Enums"；该文档明确要求使用 `@earendil-works/pi-ai` 的 `StringEnum`，并说明 `Type.Union` 和 `Type.Literal` 不兼容 Google API。官方示例见 `examples/extensions/todo.ts`。                                                 | Memory 的字符串枚举全部改用 `StringEnum`。                                                                                                                         |
| 工具失败语义              | 明确规范                | `docs/extensions.md` 的 "Signaling errors"；`execute()` 必须抛错才能生成 `isError: true`。返回对象中的 `isError` 不会设置工具错误标志。                                                                                                                                   | Memory 插件收到宿主错误结果后抛错。成功结果只返回合法 `content` 和 `details`。                                                                                     |
| `execute()` 参数          | 实现事实                | `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js` 的 `prepareToolCall()` 和 `executePreparedToolCall()`。运行时先执行 `prepareArguments()` 和校验，再把准备后的参数传给工具。`tool_execution_start` 在 preflight 阶段更早发出。                             | 宿主不再执行 `tool_execution_start.args`。插件把最终 `params` 编入私有 UI 请求，宿主严格解析后执行。                                                               |
| 并行工具调用              | 明确规范和实现事实      | `docs/extensions.md` 的 `tool_execution_start`、`tool_execution_end` 和 parallel tool mode 说明；`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js` 的 `executeToolCallsParallel()`。start 按源顺序发出，end 按完成顺序发出，最终 tool result 按源顺序提交。 | Memory 和 Telegram 都以不透明 `toolCallId` 建立独立 pending 记录，不依赖事件完成顺序。                                                                             |
| `toolCallId`              | 实现事实                | Pi 0.84.4 类型将其定义为 `string`。文档和类型均未规定分隔符或字符集，也未允许消费者拆分 provider ID。                                                                                                                                                                     | Amadeus 不拆分、不 trim、不归一化 ID。持久 receipt 保留原值。Markdown marker 对不安全值使用 SHA-256。                                                              |
| 工具取消                  | 明确规范                | `docs/extensions.md` 的 `execute(toolCallId, params, signal, onUpdate, ctx)` 示例和 "ctx.signal"；官方 `examples/extensions/timed-confirm.ts` 演示 AbortSignal。                                                                                                          | 两个插件把工具 signal 传入 UI。Memory 只读请求支持 60 秒宿主期限和 qmd 排队取消。Mutation 一旦接受仍由宿主排空。Telegram 上传响应 revision、stop、fatal 和总期限。 |
| Extension UI RPC          | 明确规范                | `docs/rpc.md` 的 "Extension UI Protocol"。dialog 方法发出 `extension_ui_request`，客户端必须用匹配的 `id` 返回 `extension_ui_response`；timeout 到期后 agent 自动返回缺省值。                                                                                             | 两个插件使用版本化 JSON 载荷。宿主按请求 `id` 响应，未知或无效请求返回 `cancelled: true`。                                                                         |
| `ctx.mode` 和 `ctx.hasUI` | 明确规范                | `docs/extensions.md` 的 "ctx.mode"、"ctx.hasUI" 和末尾模式表。                                                                                                                                                                                                            | 两个插件只在 `rpc` 模式使用 Amadeus 私有 UI。Memory snapshot 在非 RPC 模式不读取宿主。                                                                             |
| UI timeout                | 明确规范和 Amadeus 协议 | `docs/rpc.md` 说明 timeout 由 agent 侧执行；`docs/extensions.md` 说明 timeout 和 signal 的返回值。                                                                                                                                                                        | Memory snapshot 为 1 秒，Memory 工具为 65 秒。Telegram UI 为 130 秒，宿主总期限为 125 秒，给 RPC 响应保留 5 秒。                                                   |
| 工具输出边界              | 明确规范                | `docs/extensions.md` 的 "Truncating Tool Output"；官方 `examples/extensions/truncated-tool.ts`。限制为 50 KiB 或 2000 行，以先达到者为准。                                                                                                                                | Memory 最终文本，包括截断说明，不超过两个限制。超长单行保留 UTF-8 安全前缀。                                                                                       |
| session 生命周期          | 明确规范                | `docs/extensions.md` 的 session 生命周期说明。替换 session 后，旧 session 绑定对象失效。                                                                                                                                                                                  | 每个 Telegram chat 保持独立 Pi 子进程和 session。`/new`、restart、fatal 和 close 清理 pending 状态及活动 controller。                                              |
| 资源清理                  | Amadeus 协议            | Pi 规范只给出 signal 和生命周期边界。文件快照、持久去重和非幂等三态属于 Amadeus。                                                                                                                                                                                         | 上传前失败删除快照。发送成功但索引明确失败时删除无引用快照。索引超时后的迟到持久化纳入 close 排空；迟到失败删除快照。                                              |
| Telegram 非幂等结果       | Amadeus 协议            | Pi 没有规定 Telegram 发送语义。                                                                                                                                                                                                                                           | `sent`、`rejected`、`unknown` 保持分离。持久预留冲突返回 `unknown`，并明确禁止自动重试。                                                                           |
| 私有协议严格性            | Amadeus 协议            | `docs/rpc.md` 只定义 UI 外层，不定义 Amadeus 载荷。                                                                                                                                                                                                                       | Memory 和 Telegram 载荷都有 `version: 1`、严格字段集合、长度限制、工具名匹配和状态相关结果字段。                                                                   |

## 确认的问题和修复

### F1. Memory 枚举 schema 不兼容 Google provider

- 规范依据：`docs/extensions.md` 的 `StringEnum` 要求。
- 原受影响代码：`plugins/memory/index.ts` 使用 `Type.Union([Type.Literal(...)])`。
- 风险：中。Google provider 不能可靠接受工具 schema，工具可能无法注册或调用。
- 复现：`test/plugins/memory.test.ts` 的 `注册七个兼容顺序工具并拒绝额外参数` 检查序列化 schema 为标准 string enum。
- 修复：改用 `StringEnum`，并把 `@earendil-works/pi-ai` 0.84.4 声明为直接运行时依赖。

### F2. 宿主执行了 preflight 原始参数

- 规范依据：Pi 0.84.4 `agent-loop.js` 先准备和校验参数，再调用 `execute()`。`tool_execution_start` 更早发出。
- 原受影响代码：`plugins/memory/index.ts`、`plugins/telegram/index.ts` 丢弃最终 `params`；`src/bridge/chat-agent.ts` 执行 start 事件中的 `args`。
- 风险：高。hook 或准备阶段修正过的参数不会生效。宿主可能执行模型最初产生的未校验值。
- 复现：`test/bridge/agent-manager.test.ts` 的 `Memory 宿主执行 execute 收到的最终参数` 和 `Telegram 宿主发送 execute 收到的最终参数` 故意让 start 参数和 execute 参数不同。
- 修复：start 事件只登记调用身份。插件把最终 `toolName` 和 `params` 放入版本化 UI 请求。宿主校验工具名后执行最终参数。

### F3. Memory 工具错误没有设置 Pi 错误标志

- 规范依据：`docs/extensions.md` 的 "Signaling errors"。
- 原受影响代码：`plugins/memory/index.ts` 把宿主 `isError` 作为普通成功结果返回。
- 风险：中。模型会把失败结果当作成功工具输出。
- 复现：`test/plugins/memory.test.ts` 的 `宿主工具错误通过 throw 标记为 Pi 工具失败`。
- 修复：宿主结果带 `isError` 时，插件抛出 `Error`。

### F4. Memory 只读请求没有完整取消链

- 规范依据：`docs/extensions.md` 的工具 signal、`ctx.signal` 和 UI signal 说明。
- 原受影响代码：`plugins/memory/index.ts`、`src/bridge/chat-agent.ts`、`src/memory/coordinator.ts`、`src/memory/qmd.ts`。
- 风险：中。qmd search 在 UI timeout 后仍可排队和启动。新 revision 不能停止旧只读请求。
- 复现：`test/memory/qmd.test.ts` 的 `排队中的 qmd search 被取消后不会迟到启动`。旧代码会等待到测试超时。
- 修复：插件传递 signal。宿主为只读调用建立 60 秒 controller。qmd 把排队时间计入取消边界，取消后的任务不会迟到启动。Memory mutation 不使用该 controller，仍遵守已接受 mutation 必须排空的规则。

### F5. Memory 输出没有执行 Pi 的 50 KiB 和 2000 行限制

- 规范依据：`docs/extensions.md` 的 "Truncating Tool Output" 和 `examples/extensions/truncated-tool.ts`。
- 原受影响代码：`plugins/memory/index.ts` 原样返回宿主文本。
- 风险：中。大 memory read 或 search 会把过量文本写入模型上下文。
- 复现：`test/plugins/memory.test.ts` 的 `工具输出按 UTF-8 字节和行数截断`，包含中文长单行和 2100 行输入。
- 修复：使用 Pi 0.84.4 的 `truncateHead`。先为说明文本预留字节和一行。首行超过限制时保留 UTF-8 安全前缀。最终断言不超过 50 KiB 和 2000 行。

### F6. 不透明 ID 被当作受限标识符和 Markdown 内容

- 规范依据：Pi 类型只保证 `toolCallId` 是 string，没有字符集或分隔符合同。
- 原受影响代码：`plugins/memory/protocol.ts` 限制 receipt 字符；`src/memory/store.ts` 把 receipt 原样放进 HTML comment。
- 风险：高。控制字符仍会让合法的不透明 receipt 被拒绝。包含 comment 终止符或换行的 ID 会破坏 Markdown marker。
- 基线说明：`2fc12e5` 已修复带 `|` 的 provider 复合 ID。本次没有把该旧问题重复计入发现。`same-turn.jsonl` 在本次只增加最终 `toolName` 和 `args` 载荷。
- 复现：`test/plugins/memory-protocol.test.ts` 验证控制字符 receipt 保留原值。`test/memory/store.test.ts` 的 `不透明 receipt ID 不会破坏 Markdown marker` 使用换行和 comment 终止序列。
- 修复：协议只做有界字符串检查并保留原值。安全 marker 保留兼容格式；其他值使用完整 SHA-256。幂等 receipt 键仍使用原值。

### F7. Telegram 工具未传播取消，且没有总期限

- 规范依据：工具 `execute` signal 和 RPC UI timeout 规则。
- 原受影响代码：`plugins/telegram/index.ts`、`src/bridge/chat-agent.ts`、`src/telegram/outbound.ts`。
- 风险：高。130 秒 UI timeout 不能覆盖文件验证、120 秒上传和 5 秒索引。UI 结束后可能迟到发送非幂等请求。
- 复现：`test/bridge/agent-manager.test.ts` 的 `新 revision 会通过 signal 中止已开始的 Telegram 上传`；`test/telegram/outbound.test.ts` 的 `宿主总 deadline 在上传前到期时不会调用 Telegram`。
- 修复：插件传递 signal。宿主从收到 UI 请求起计算 125 秒期限。验证、snapshot、API 和索引共享该期限。API 开始前到期返回 rejected；API 开始后结果不确定则返回 unknown。

### F8. Telegram 私有协议不严格

- 规范依据：外层遵守 `docs/rpc.md`。内层是 Amadeus 协议，必须避免参数解释差异。
- 原受影响代码：`plugins/telegram/protocol.ts`、`plugins/telegram/index.ts`。
- 风险：中。空 caption 的 schema 和 parser 不一致；结果额外字段及无界字符串可穿过协议边界。
- 复现：`test/plugins/telegram.test.ts` 的 `空 caption 与公开 schema 保持一致` 和 `拒绝无效、额外或类型不匹配的结果`。
- 修复：增加版本化 send 请求。空 caption 规范化为缺省。结果按状态限制字段、类型和字符串长度。

### F9. 过期 tool end 不清理 pending 状态

- 规范依据：并行事件完成顺序和 session 生命周期。pending map 是 Amadeus 状态。
- 原受影响代码：`src/bridge/chat-agent.ts` 在 control epoch 过滤后才处理 `tool_execution_end`。
- 风险：中。stop 或 session 切换后的完成事件会被直接丢弃，pending 记录泄漏，迟到 UI 请求可能错误命中旧调用。
- 复现：`test/bridge/agent-manager.test.ts` 的 `过期 tool_execution_end 仍清理待处理工具`。
- 修复：先删除 Memory 和 Telegram pending 记录，再按 epoch 过滤其余事件处理。

### F10. Telegram 快照在失败路径泄漏

- 规范依据：Amadeus 资源清理合同。
- 原受影响代码：`src/telegram/outbound.ts` 在 Telegram 明确拒绝、网络失败、timeout 或索引失败后保留 `.bin`。
- 风险：中。每个 document 最多 50 MiB。持续失败可增长磁盘占用。
- 复现：`test/telegram/outbound.test.ts` 检查明确 4xx、网络失败、请求 timeout、总期限、状态写入失败和状态写入 timeout 后迟到失败的 snapshot 目录。
- 修复：上传前失败立即删除。Telegram 已发送但索引明确失败时删除无引用快照。索引 timeout 后继续观察持久化 Promise，迟到失败时删除。

### F11. Telegram 重放冲突被错误归类为 rejected

- 规范依据：Amadeus 的非幂等三态合同。
- 原受影响代码：`src/bridge/chat-agent.ts` 只保存调用预留，重放时统一返回 `duplicate_tool_call` rejected。
- 风险：中。崩溃点可能位于 Telegram 已发送之后。rejected 会暗示调用确定未发送，模型可能重试。
- 复现：`test/bridge/agent-manager.test.ts` 的 `持久 reservation 冲突返回 unknown 且不重新发送` 先把 reservation 写入 `StateStore`，再创建空内存去重集合的新 agent。该测试直接进入持久冲突分支。
- 修复：内存重复观察和持久预留冲突都返回 unknown，消息明确包含 `Do not retry automatically`。

### F12. 新的运行时 import 没有直接依赖

- 规范依据：Node/Bun 包解析规则。插件运行时 value import 必须来自直接运行时依赖。
- 原受影响代码：`package.json` 只把 `@earendil-works/pi-coding-agent` 放在 devDependencies，并通过传递依赖取得 `pi-ai`。
- 风险：中。production-only 安装可能无法加载 Memory 插件。
- 复现：`test/plugins/runtime-dependencies.test.ts` 读取 Memory 插件的 value imports 和 `package.json`，要求两个包都是版本为 0.84.4 的直接 dependencies。该测试在 `2fc12e5` 上失败。
- 修复：把 `@earendil-works/pi-ai` 和 `@earendil-works/pi-coding-agent` 0.84.4 都声明为直接 dependencies，并更新 `bun.lock`。

### F13. Memory 结果协议没有按状态拒绝额外字段

- 规范依据：内层是 Amadeus 私有协议。严格状态字段可以防止生产者和消费者对结果含义产生分歧。
- 原受影响代码：`plugins/memory/protocol.ts` 只对所有状态字段的并集执行一次检查。completed 可以携带 code，unavailable snapshot 可以携带 content，parser 会静默丢弃这些字段。
- 风险：中。协议两端发生版本或状态解释差异时，宿主结果会被静默改写。
- 复现：`test/plugins/memory-protocol.test.ts` 分别给 unavailable snapshot 和 completed tool result 增加不适用字段，要求 parser 报 `unknown fields`。测试在 `e659fb4` 上失败。
- 修复：每个 snapshot 和 tool result 状态使用自己的字段集合执行 `assertOnlyKeys()`。

### F14. Telegram 索引 timeout 后的持久化没有进入关闭生命周期

- 规范依据：Amadeus 的优雅关闭合同要求排空已接受的异步工作。Pi 的 signal 和 UI timeout 只限制工具等待，不会替宿主管理迟到 Promise。
- 原受影响代码：`src/telegram/outbound.ts` 在索引 timeout 后返回 unknown，只挂接迟到失败清理。`TelegramOutboundSender.close()` 只等待发送主 Promise，该主 Promise 已经返回。
- 风险：中。进程可能在已接受的状态持久化仍运行时退出。迟到失败清理也可能在 close 返回后被中断。
- 复现：`test/telegram/outbound.test.ts` 的 `状态持久化超时后 close 会排空已接受的迟到成功` 和 `状态持久化超时后迟到失败会清理快照并完成关闭`。两个测试在 `0c811da` 上都失败。
- 修复：把 timeout 后的状态持久化包装为 `#indexSettlementTasks`。close 先等待活动发送，再等待这些 settlement task。迟到成功保留已索引快照；迟到失败先删除快照再完成关闭。

## Red 和 green 证据

### 修复前

在 detached worktree 中检出 `2fc12e5`，只应用 `e659fb4` 的测试和脱敏 fixture 变更，不应用生产代码：

```sh
git worktree add --detach /tmp/amadeus-pi-audit-red 2fc12e5
git diff 2fc12e5 e659fb4 -- \
  test/bridge/agent-manager.test.ts \
  test/fixtures/memory-tools/same-turn.jsonl \
  test/memory/qmd.test.ts \
  test/memory/store.test.ts \
  test/plugins/memory-protocol.test.ts \
  test/plugins/memory.test.ts \
  test/plugins/telegram.test.ts \
  test/telegram/outbound.test.ts \
  | git -C /tmp/amadeus-pi-audit-red apply
cd /tmp/amadeus-pi-audit-red
bun install --frozen-lockfile
bun test \
  test/plugins/memory.test.ts \
  test/plugins/memory-protocol.test.ts \
  test/plugins/telegram.test.ts \
  test/bridge/agent-manager.test.ts \
  test/memory/store.test.ts \
  test/telegram/outbound.test.ts
```

实际结果：

```text
85 pass
30 fail
Ran 115 tests across 6 files.
exit status 1
```

这组 red 运行证明旧生产代码不能满足新回归合同，但部分宿主测试会先被旧版私有 UI 载荷拦截。因此不能用 30 个失败的总数单独证明每个事件路径。逐项证据如下：

- F1、F3、F5：Memory 插件测试直接调用旧 `execute()`，分别在 schema、throw 语义和输出边界断言失败。
- F2：Memory 和 Telegram 插件测试显示旧 UI placeholder 只有 `toolCallId`，没有最终 `toolName`、`params` 或 signal。这直接证明宿主不可能收到 `execute()` 的最终参数。
- F6：Memory protocol 控制字符 receipt 测试和 store marker 测试失败。
- F7：Telegram 插件 signal 断言失败；outbound 的上传前 deadline 测试失败。
- F8：空 caption 和逐状态额外字段测试失败。
- F10：明确 4xx、网络失败、timeout 和状态写入失败后的 snapshot 清理断言失败。
- F12：`test/plugins/runtime-dependencies.test.ts` 在 `2fc12e5` 上缺少两个直接 dependencies，断言失败。
- F13：逐状态 Memory 结果字段测试在 `e659fb4` 上接受额外字段，因此断言失败。
- F14：两个索引 settlement 测试在 `0c811da` 上失败。旧 close 提前返回，迟到失败的快照在 close 返回时仍存在。

F9 和 F11 需要让基线使用它当时的 raw-ID UI 载荷。验证时只把测试 helper 从版本化 JSON 改回 `return toolCallId`，不改测试步骤和断言。两个测试都在 `2fc12e5` 上到达目标分支并失败：

```text
(fail) PiAgentManager > 过期 tool_execution_end 仍清理待处理工具
Expected: { cancelled: true }
Received: { value: "{...stale_revision...}" }

(fail) PiAgentManager > 持久 reservation 冲突返回 unknown 且不重新发送
Expected status: unknown
Received status: rejected
```

这两个兼容性 adapter 只对应 F2 修复前后的私有 UI 编码差异。当前回归测试不需要 adapter。

F12 的独立 red 运行把当前 `test/plugins/runtime-dependencies.test.ts` 复制到 `2fc12e5`，结果为 0 pass、1 fail。F13 的独立 red 运行只把当前 Memory protocol 测试差异应用到 `e659fb4`，结果为 5 pass、2 fail。completed 和 unavailable 两种状态都错误接受了额外字段。

单独运行 qmd 取消测试时，旧实现超过 Bun 的 5000 ms 测试期限，覆盖 F4：

```text
(fail) QmdCoordinator > 排队中的 qmd search 被取消后不会迟到启动
this test timed out after 5000ms
```

### 修复后

`e659fb4` 的全套结果为 342 pass、0 fail。加入审计证据回归和 F13 修复后为 343 pass。加入 F14 生命周期修复后，本文所在提交的结果为：

```text
344 pass
0 fail
1152 expect() calls
Ran 344 tests across 43 files.
```

## 完整验证

以下命令在 `e659fb4` 上通过：

```sh
bun test
bun run typecheck
bun build --target bun src/index.ts --outdir /tmp/amadeus-audit-main
bun build --target bun plugins/telegram/index.ts --outdir /tmp/amadeus-audit-telegram
bun build --target bun plugins/memory/index.ts --outdir /tmp/amadeus-audit-memory
bun build --target bun scripts/migrate-memory-daily.ts --outdir /tmp/amadeus-audit-migrate
nix fmt
nix build .#default --no-link
nix flake check
nix flake check --all-systems --no-build
git diff --check
```

Nix 验证结果：x86_64-linux package 和 NixOS module 构建通过；aarch64-linux package、formatting 和 module derivation 完成求值；all-systems flake 检查通过。

## 独立复审

只读 Oracle 复审先报告 3 个中风险问题：Telegram 重放三态、Memory 严格截断边界和 Telegram 无引用快照。修复并增加测试后，同一复审器再次检查当前工作树，结论如下：

```text
未发现仍存在的高风险或中风险问题。
```

复审同时运行了重点测试、`bun run typecheck` 和 `git diff --check`。

第一次目标审计拒绝了缺少受版本控制矩阵和逐项证据的提交。补充本文后，第二次只读报告复审又指出持久 reservation 测试未到达持久分支、F12 缺少测试、F6 基线描述不准、Memory 结果字段不够严格，以及不存在的 `src/pi-extension/` 路径。本文所在提交逐项修复了这些问题。第三次独立只读复查核对 F1 至 F13、red adapter、当前代码和 343 项测试，结论为“未发现仍存在的高风险或中风险问题”。第二次目标审计随后发现 F14：索引 timeout 后的持久化未进入 close 生命周期。本文所在提交增加 settlement task 排空和迟到成功、失败测试。第四次独立只读复查确认没有 task 收集 race、未处理 rejection、快照误删或新的高、中风险问题。最终全套验证由主执行过程再次运行。
