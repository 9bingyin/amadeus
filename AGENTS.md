# 项目约定

- 坚持简洁设计：除非有明确需求，不为 Agent 循环引入固定调用次数、超时、重试、Token、费用或轮次等人为限制。
- 使用 Bun + TypeScript，以 pi-durable 作为 Agent 运行框架。
- 使用 flake-parts + direnv 管理开发环境（`use flake`）。
- 使用 treefmt 统一格式化：`nix fmt`；使用 `nix flake check` 检查格式。
- `.test_home/` 保留旧实现的本地数据，不提交 Git；未经明确要求，不修改或迁移其中的数据。
- 状态目录默认 `.amadeus/`：`session.sqlite` 保存 pi-durable 数据，`amadeus.lock` 使用非阻塞 `flock` 保证单写者；先取得锁再打开存储，先关闭 Harness 再释放锁，不删除锁文件，不另建锁数据库。

# 实现规范

- 以当前依赖的官方文档和推荐接口为准，不照搬旧实现，不为兼容旧架构添加适配层。
- 按功能划分目录：`src/config/` 负责配置，`src/agent/` 负责 Agent 与模型，`src/telegram/` 负责 Telegram 对接；`src/main.ts` 只负责组装和启动。
- 优先直接使用库的能力：grammY 负责命令匹配、过滤和中间件；pi-durable 负责会话、提交、任务、取消及恢复。不重复实现库已有的机制。
- 成功回复通过 `GenerationTask.afterRun` 返回 `runEndTask`，发送属于当前运行，不维护额外发送链；Telegram 目标记录在输入的 typed entry 中。失败通知依据 submission 结算结果持久化处理，不能只依赖 `afterRun` 或瞬时监听。
- 文本输入通过原生 `requestId` 去重，命令单独记录处理收据。普通命令回执直接使用 `ctx.reply()`，不保证崩溃后补发；收据不代表命令副作用原子执行，Telegram 发送也不承诺严格 exactly-once。
- 只实现当前需求，尽量减少封装、抽象、兼容逻辑和防御性分支；但保留权限、数据保护和存储单写者等必要安全边界。
- 类型断言（`as`）和非空断言（`!`）优先通过类型收窄消除；确需保留时，在使用处注释说明库的兼容问题或成立的流程前提，不堆叠冗余运行时检查。

# 错误处理

- 当前阶段直接输出原始错误对象或上游错误内容，保留堆栈和附加字段；不包装错误，不替换成通用失败提示，不自行添加错误文案。
- 尽量不手写 `throw new Error`，不为流程自身已保证存在的会话、路由、输入记录添加重复检查。
- 底层库负责的校验交给底层；必要的配置校验统一使用 Zod，直接输出原始 `ZodError`。
- `catch` 仅用于必要的资源释放、正常取消处理或原样输出、重抛错误；不吞掉真实异常。正常停止和重置不视为错误。

# 测试

- 只保留必要的应用层测试，重点覆盖权限边界、会话生命周期、持久化恢复、消息发送和错误透传。
- 不重复测试依赖库已有的协议解析、命令匹配、模型元数据等行为，不为假设场景堆积测试或增加生产代码封装。
- 使用 `bun test` 运行测试，使用 `bun run check` 检查类型。

# 文档

pi-durable: https://github.com/earendil-works/pi/blob/main/packages/durable/README.md

pi-ai: https://github.com/earendil-works/pi/blob/main/packages/ai/README.md

grammy: https://grammy.dev/guide/
