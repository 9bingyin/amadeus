# 项目约定

- 坚持简洁设计：除非有明确需求，不为 Agent 循环引入固定调用次数、超时、重试、Token、费用或轮次等人为限制。
- 会话状态在 `$AMADEUS_HOME/state.db`（未设置时为 `~/.amadeus/state.db`）。在 `nix develop` 里用 `sqlite3` 查看，例如：

```sh
sqlite3 "${AMADEUS_HOME:-$HOME/.amadeus}/state.db" .tables
sqlite3 "${AMADEUS_HOME:-$HOME/.amadeus}/state.db" "SELECT seq, kind FROM records ORDER BY seq;"
```
