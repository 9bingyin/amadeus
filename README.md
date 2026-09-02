# Amadeus

Telegram 与 Pi RPC 的私聊桥接服务。

> 当前为 unstable。配置格式和内部接口可能改变。

## 要求

- [Bun](https://bun.sh/)
- `PATH` 中可用的 `pi` CLI
- Telegram Bot Token

## 运行

复制并修改配置：

```bash
cp config.example.json config.json
bun run start
```

路径配置可省略。默认目录如下：

- 状态：`~/.amadeus/state`，主状态文件为 `state.json`
- 会话：`~/.amadeus/sessions`
- 附件：`~/.amadeus/attachments`
- 工作区：`~/.amadeus/workspace`

可以单独覆盖任意路径。`~/` 指向用户主目录，相对路径以 `config.json` 所在目录为基准：

```json
{
  "paths": {
    "stateDir": "data/state",
    "sessionDir": "data/sessions",
    "attachmentsDir": "data/attachments",
    "workspaceDir": "workspace"
  }
}
```

Pi RPC 没有单独的工作区参数。Amadeus 以 `paths.workspaceDir` 作为 Pi 子进程的当前工作目录。Pi 从这里解析文件工具路径、项目配置和上下文文件。

## Telegram 文件工具

可选插件 `plugins/telegram/index.ts` 注册两个 Pi 工具：

- `telegram_send_document`
- `telegram_send_photo`

安装到当前项目：

```bash
pi install ./plugins/telegram/index.ts -l
```

重启 Amadeus 后生效。移除命令：

```bash
pi remove ./plugins/telegram/index.ts -l
```

工具参数：

```json
{
  "path": "工作区内的相对路径或绝对路径",
  "caption": "可选纯文本"
}
```

路径必须位于 `paths.workspaceDir`。符号链接按 `realpath` 检查。工具不接受 chat ID、reply message ID、URL、Telegram file ID 或 Bot Token。

限制：

- document 最大 50 MiB
- photo 最大 10 MiB，只接受 JPEG、PNG 或 WebP
- caption 最大 1024 个 UTF-16 单元
- Telegram 请求超时为 120 秒

发送结果为 `sent`、`rejected` 或 `unknown`。`unknown` 表示无法确认完整结果，Amadeus 不会自动重试。同一 session 中重复的 `toolCallId` 也不会再次发送。

Pi 插件不接触 Bot Token 和 chat 路由。文件校验、Telegram API 调用和状态持久化由 Amadeus 处理。

## 检查

```bash
bun test
bun run typecheck
nix fmt
nix flake check
```

## 许可证

[MIT](LICENSE)
