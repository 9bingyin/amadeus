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
- 记忆：`~/.amadeus/memory`

可以单独覆盖任意路径。`~/` 指向用户主目录，相对路径以 `config.json` 所在目录为基准：

```json
{
  "paths": {
    "stateDir": "data/state",
    "sessionDir": "data/sessions",
    "attachmentsDir": "data/attachments",
    "workspaceDir": "workspace",
    "memoryDir": "memory"
  }
}
```

Pi RPC 没有单独的工作区参数。Amadeus 以 `paths.workspaceDir` 作为 Pi 子进程的当前工作目录。Pi 从这里解析文件工具路径、项目配置和上下文文件。

## Telegram 语音转录

可选启用 `stt.enabled`，并在私有配置文件中设置独立的 `stt.apiKey`。只转录 Telegram `voice`，默认模型为 `microsoft/mai-transcribe-2`，通过 OpenRouter 官方 SDK 调用。原语音会发送给 OpenRouter 及其模型提供商，请只在接受此数据处理方式时启用。

运行依赖为系统安装的 **FFmpeg**，需支持 Opus 解码和 FLAC 编码。默认从 PATH 查找 `ffmpeg`，可用 `stt.ffmpegCommand` 指定路径。NixOS 可设置 `services.amadeus.extraPackages = [ pkgs.ffmpeg ];`。未启用 STT 时不要求 FFmpeg；运行完整测试套件需要 FFmpeg，用于生成并转码合成音频。不要把真实 API Key 写入会进入 Nix store 的 `settings`；使用运行时私有 `configFile`。

原始语音保持不变。转录前转换为临时单声道 16 kHz FLAC，完成或取消后删除临时文件。默认最长 600 秒，转码和 API 共享 60 秒期限，分别由 `stt.maxDurationSeconds` 和 `stt.timeoutMs` 配置。语音下载另有 30 秒期限。可配置的转录期限最多 300 秒，录音时长最多 3600 秒。原文件及转码输出受 20 MiB 限制；STT HTTP 响应最多 256 KiB，转录文本最多 50 KiB。超限、空结果或失败会明确标注为转录不可用，仍把原附件交给 LLM，不自动重试转录请求。

转录文字作为附件的 `<transcription>` 元数据传入，标注来源、提供商、模型和状态。已下载的原语音路径仍供工具访问，引用已索引消息时保留转录信息。机器转录不保证准确；提供路径也不表示当前模型可以直接理解音频。

协议与格式依据（2026-09-05 核对）：

- [OpenRouter 模型页](https://openrouter.ai/microsoft/mai-transcribe-2)确认模型 ID、Azure 提供商和 `/api/v1/audio/transcriptions` 端点。
- [OpenRouter STT 指南](https://openrouter.ai/docs/guides/overview/multimodal/stt)规定 JSON 请求中的 `model`、`input_audio.data`（原始字节的 Base64）和 `input_audio.format`，其中列有 `flac`。具体格式支持仍取决于提供商。
- [Microsoft MAI-Transcribe-2 文档的 Prerequisites](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/mai-transcribe#prerequisites)明确列出 WAV、MP3、FLAC。因此选择 FLAC，不假设 Telegram OGG/Opus 可直接被目标模型接受。
- 固定使用 `@openrouter/sdk` 1.2.106；[对应源码的请求类型](https://github.com/OpenRouterTeam/typescript-sdk/blob/e8db5f5089a32c07b2aa21aff79b6f46ce17b349/src/models/operations/createaudiotranscriptions.ts)要求 `sttRequest` 外层，与 STT 指南中的简写示例不同。实现按发布版类型调用。

这些是官方协议与格式支持依据，不是线上实测报告。回归测试使用合成音频和 fake API，未发起真实付费转录请求。

## NixOS

模块可以从 Nix 设置生成配置，也可以从独立文件读取 Telegram Bot Token。下面的示例使用 [sops-nix](https://github.com/Mic92/sops-nix)：

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    amadeus.url = "github:9bingyin/amadeus";
    sops-nix.url = "github:Mic92/sops-nix";
    sops-nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { nixpkgs, amadeus, sops-nix, ... }: {
    nixosConfigurations.host = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        amadeus.nixosModules.default
        sops-nix.nixosModules.sops
        ({ config, pkgs, ... }: {
          sops.defaultSopsFile = ./secrets.yaml;
          sops.secrets.amadeus-telegram-bot-token.restartUnits = [
            "amadeus.service"
          ];

          services.amadeus = {
            enable = true;
            telegramBotTokenFile =
              config.sops.secrets.amadeus-telegram-bot-token.path;

            settings = {
              telegram = {
                allowedUserIds = [ 123456789 ];
                streamResponses = false;
              };
              pi = {
                command = "pi";
                args = [ ];
              };
              paths = {
                stateDir = "/var/lib/amadeus/state";
                sessionDir = "/var/lib/amadeus/sessions";
                attachmentsDir = "/var/lib/amadeus/attachments";
                workspaceDir = "/var/lib/amadeus/workspace";
                memoryDir = "/var/lib/amadeus/memory";
              };
            };

            extraPackages = [ pkgs.git ];
          };
        })
      ];
    };
  };
}
```

`settings` 会序列化到 Nix store。可以直接设置 `settings.telegram.botToken`；如果不希望 Token 进入 store，则使用 `telegramBotTokenFile`。模块通过 systemd credential 读取该文件，并在 `/run/amadeus/config.json` 生成仅供服务使用的完整配置。sops-nix secret 可以保持 root 所有；也可以把 agenix 或其他密钥模块生成的文件路径传给该选项。

直接配置 Token 也有效：

```nix
services.amadeus.settings.telegram.botToken = "replace-with-botfather-token";
```

如果已经由外部工具生成 JSON，可以使用：

```nix
services.amadeus = {
  enable = true;
  configFile = "/run/secrets/amadeus.json";
};
```

`configFile` 和 `settings` 是两种基础配置来源，必须二选一。`telegramBotTokenFile` 是可选覆盖，可以与任意一种来源组合。

模块默认不创建用户，也不设置 systemd `User`，因此服务按 root 运行。服务 HOME 固定为 `/var/lib/amadeus`。如果需要使用已有的低权限用户，可以设置 `services.amadeus.user`；模块不会创建该用户。Pi 的用户级配置和认证需要放在 `/var/lib/amadeus/.pi/agent/`，并由运行服务的用户持有。

默认使用 nixpkgs 中的 `pi-coding-agent`。`extraPackages` 中的命令会加入服务 PATH，供 Pi 工具调用。

直接构建程序：

```bash
nix build github:9bingyin/amadeus
```

## 异步记忆

内置记忆宿主默认关闭。启用后，Amadeus 管理全局共享的 `MEMORY.md`、`SCRATCHPAD.md`、`daily/` 和 `recovery/`，并在 session 切换后异步提取记忆：

```json
{
  "memory": {
    "enabled": true,
    "extractionModel": "provider/model",
    "extractionTimeoutMs": 60000,
    "qmd": {
      "enabled": true,
      "command": "qmd",
      "searchTimeoutMs": 60000
    }
  }
}
```

`extractionModel` 可省略。省略时，独立 worker 使用 Pi 的默认模型。worker 不加载 session、extension、工具、skills、prompt template、theme 或项目 context 文件。

可选插件 `plugins/memory/index.ts` 注册兼容工具：

- `memory_write`
- `memory_forget`
- `memory_restore`
- `memory_read`
- `memory_search`
- `memory_status`
- `scratchpad`

安装到当前项目：

```bash
pi install ./plugins/memory/index.ts -l
```

移除命令：

```bash
pi remove ./plugins/memory/index.ts -l
```

插件只负责稳定快照注入、工具注册和私有 RPC。工具写入只等待本地原子持久化，不等待 LLM、`qmd update` 或 `qmd embed`。session 切换只等待小型 JSONL checkpoint，不等待记忆提取。

自动 daily 摘要兼容 `pi-memory` 0.4.2：至少 4 条会话消息才启动提取；输入使用与 Pi `convertToLlm`、`serializeConversation` 相同的文本语义，包含当前 branch 的 assistant thinking、工具调用、工具结果和最终回复；超过 80,000 字符时只保留会话尾部。模型使用原 `pi-memory` system/user prompt，并只返回 `Decisions`、`Lessons Learned`、`Notes` 和 `Follow-ups` 四个 Markdown 分区。全为 `None.` 的摘要不会写入。`memory.extractionModel` 会接收这些会话内容，应只配置可信模型。宿主仍以持久后台任务处理完整 session，不阻塞 `/new`、工具调用或正常关闭。

`qmd` 可选。启用后，Amadeus 串行管理名为 `pi-memory` 的 collection、`qmd update` 和 `qmd embed`。索引未就绪或命令失败时，搜索降级为本地关键词搜索。NixOS 用户需要把可执行的 `qmd` package 放入 `services.amadeus.extraPackages`，或关闭 `memory.qmd.enabled`。

Amadeus 不自动加载该插件，也不修改 Pi 的 extension、provider、model 或工具配置。所有白名单 chat 共享同一份记忆。

从 `pi-memory` 切换时：

1. 保留原有 memory 目录，并把它配置为 `paths.memoryDir`。
2. 启用 `memory.enabled`，安装 Amadeus memory 插件。
3. 从 Pi 用户配置中移除 `npm:pi-memory`，并移除 `PI_MEMORY_*` 环境变量。
4. 重启服务，确认 `memory_status` 可用，再执行一次 `memory_search`。

不要同时加载两个 memory 插件。Amadeus 不会自动修改现有部署或 Pi 配置。

早期 Amadeus 版本可能已生成带完整 `amadeus-memory:extract:...` 标记的零散 daily 记录。升级后可以先停止服务并执行只读检查：

```bash
amadeus-memory-migrate --memory-dir /var/lib/amadeus/memory
```

确认数量后执行迁移：

```bash
amadeus-memory-migrate \
  --memory-dir /var/lib/amadeus/memory \
  --state-dir /var/lib/amadeus/state \
  --apply \
  --service-stopped
```

`--memory-dir` 和 `--state-dir` 必须与配置中的 `paths.memoryDir`、`paths.stateDir` 一致。`--service-stopped` 是显式安全确认；迁移工具不能替代停服。工具会转换两类边界明确的 Amadeus 管理内容：旧的单段 extraction 碎片会按 session 合并到 `Session Summary (migrated)`；现有 `Session Summary (auto)` 会转换为兼容 `pi-memory` 的四分区格式。dry-run 会报告 `migratedManagedSummaries`。如果报告 `ambiguousFragments`，应用模式会拒绝修改，需先人工检查对应 daily 文件。若存在尚未恢复的 prepared memory receipt，应用模式也会拒绝修改，需先用当前版本完成恢复并再次干净停服。工具不会重写原 `pi-memory` 摘要或手写内容。应用模式会在 memory 目录旁创建完整备份，并推进 memory revision，使 qmd 在服务重启后重新追赶索引。迁移完成后再启动服务。

## Telegram 文件工具

可选插件 `plugins/telegram/index.ts` 注册两个 Pi 工具。Amadeus 不自动加载该插件：

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
