# Amadeus

Telegram 与 Pi RPC 的私聊桥接服务。

> 当前为 unstable。配置格式和内部接口可能改变。

## 运行

需要 [Bun](https://bun.sh/)、PATH 中可用的 `pi` CLI 和 Telegram Bot Token。

```bash
bun install
cp config.example.json config.json
# 编辑 config.json，填写 Token 和用户白名单
bun run start
```

配置示例见 [config.example.json](config.example.json)。路径可省略，默认使用：

| 内容    | 目录                     |
| ------- | ------------------------ |
| 状态    | `~/.amadeus/state`       |
| Pi 会话 | `~/.amadeus/sessions`    |
| 附件    | `~/.amadeus/attachments` |
| 工作区  | `~/.amadeus/workspace`   |
| 记忆    | `~/.amadeus/memory`      |

`~/` 指向用户主目录，相对路径以配置文件所在目录为基准。`paths.workspaceDir` 是 Pi 子进程的工作目录，也是文件工具和项目配置的解析位置。

## 语音转录

只转录 Telegram `voice`，默认关闭。在私有配置文件中启用：

```json
{
  "stt": {
    "enabled": true,
    "apiKey": "replace-with-openrouter-api-key"
  }
}
```

- 使用 OpenRouter 官方 SDK，默认模型为 `microsoft/mai-transcribe-2`。
- 需要系统 **FFmpeg**，支持 Opus 解码和 FLAC 编码。默认从 PATH 查找，可通过 `stt.ffmpegCommand` 指定路径。
- 默认最长 600 秒，转码和转录共享 60 秒期限，可通过 `stt.maxDurationSeconds` 和 `stt.timeoutMs` 调整。原文件及转码输出上限为 20 MiB。
- 原语音保持不变，临时 FLAC 在完成或取消后删除。LLM 收到转录来源、模型、状态及原附件路径，后续引用可恢复转录信息。
- 失败或空结果会标注为不可用，仍交付原附件，不自动重试。服务日志记录脱敏的请求失败信息。

启用后，语音内容会发送给 OpenRouter 及其模型提供商。机器转录可能不准确；提供原附件路径不代表当前模型能够直接理解音频。

## NixOS

导入 `amadeus.nixosModules.default`，使用运行时私有 JSON 配置：

```nix
services.amadeus = {
  enable = true;
  configFile = "/run/secrets/amadeus.json";
  extraPackages = [ pkgs.git pkgs.ffmpeg ];
};
```

未启用语音转录时可移除 `pkgs.ffmpeg`。`extraPackages` 中的命令会加入服务 PATH，默认 Pi 包为 nixpkgs 的 `pi-coding-agent`。

也可用 `services.amadeus.settings` 生成配置，但它与 `configFile` 必须二选一。**`settings` 会进入 Nix store，不要写入真实密钥。** Telegram Token 可通过 `telegramBotTokenFile` 从 sops-nix、agenix 等提供的文件读取；该选项可覆盖任一种配置来源。

模块默认以 root 运行，HOME 为 `/var/lib/amadeus`。可通过 `services.amadeus.user` 指定已有用户，模块不会创建用户。Pi 配置和认证放在 `/var/lib/amadeus/.pi/agent/`，并确保运行用户可以访问。

```bash
nix build github:9bingyin/amadeus
```

## 异步记忆

内置记忆宿主默认关闭。启用 `memory.enabled` 后，所有白名单 chat 共享 `MEMORY.md`、`SCRATCHPAD.md`、`daily/` 和 `recovery/`。

```json
{
  "memory": {
    "enabled": true,
    "extractionModel": "provider/model",
    "qmd": { "enabled": false }
  }
}
```

`extractionModel` 可省略，默认使用 Pi 的模型。提取在独立 worker 中进行，不加载用户扩展或工具。提取输入包含会话正文、thinking、工具调用和结果，因此只应配置可信模型。

安装可选工具插件：

```bash
pi install ./plugins/memory/index.ts -l
```

提供 `memory_write`、`memory_forget`、`memory_restore`、`memory_read`、`memory_search`、`memory_status` 和 `scratchpad`。Amadeus 不自动加载插件，也不修改用户的 Pi 配置。

`qmd` 用于语义搜索。启用时需提供可执行的 `qmd`，NixOS 可将其加入 `extraPackages`。索引未就绪或失败时，搜索降级为本地关键词搜索。后台提取和索引不阻塞工具写入或 `/new`。

## Telegram 文件工具

安装可选插件并重启 Amadeus：

```bash
pi install ./plugins/telegram/index.ts -l
```

提供 `telegram_send_document` 和 `telegram_send_photo`，参数为：

```json
{
  "path": "工作区内的相对路径或绝对路径",
  "caption": "可选纯文本"
}
```

路径必须位于 `paths.workspaceDir`，符号链接也会检查实际路径。不接受 URL、Telegram file ID 或自定义 chat 路由。

- document 最大 50 MiB。
- photo 最大 10 MiB，只接受 JPEG、PNG 或 WebP。
- caption 最大 1024 个 UTF-16 单元。
- 结果分为 `sent`、`rejected` 和 `unknown`。`unknown` 表示无法确认完整结果，不会自动重试；同一 session 的重复工具调用也不会再次发送。

插件可用对应路径移除，例如：

```bash
pi remove ./plugins/telegram/index.ts -l
```

## 检查

完整测试需要 FFmpeg，用于生成和转码合成音频。

```bash
bun test
bun run typecheck
nix fmt
nix flake check
```

## 许可证

[MIT](LICENSE)
