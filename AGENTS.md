# 项目约定

- 坚持简洁设计：除非有明确需求，不为 Agent 循环引入固定调用次数、超时、重试、Token、费用或轮次等人为限制。
- 使用 Bun + TypeScript，以 pi-durable 作为 Agent 运行框架。
- 使用 flake-parts + direnv 管理开发环境（`use flake`）。
- 使用 treefmt 统一格式化：`nix fmt`；使用 `nix flake check` 检查格式。
- `.test_home/` 保留旧实现的本地数据，不提交 Git；未经明确要求，不修改或迁移其中的数据。

# 文档

pi-durable: https://github.com/earendil-works/pi/blob/main/packages/durable/README.md
