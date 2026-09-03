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
