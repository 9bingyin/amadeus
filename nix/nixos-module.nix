{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.amadeus;
  system = pkgs.stdenv.hostPlatform.system;
  usesConfigFile = cfg.configFile != null;
  usesSettings = cfg.settings != { };
  usesTokenFile = cfg.telegramBotTokenFile != null;
  settingsConfigFile = pkgs.writeText "amadeus-config.json" (builtins.toJSON cfg.settings);
  baseConfigFile = if usesConfigFile then cfg.configFile else settingsConfigFile;
  runtimeConfigFile = "/run/amadeus/config.json";
  configFile = if usesTokenFile then runtimeConfigFile else baseConfigFile;
  buildRuntimeConfig = pkgs.writeShellScript "amadeus-build-runtime-config" ''
    set -eu
    umask 077

    temporary="$RUNTIME_DIRECTORY/config.json.tmp"
    trap 'rm -f "$temporary"' EXIT

    ${lib.getExe pkgs.jq} \
      --rawfile token "$CREDENTIALS_DIRECTORY/telegram-bot-token" \
      'if ($token | sub("[\r\n]+$"; "")) == "" then
         error("Telegram bot token is empty")
       else
         .telegram.botToken = ($token | sub("[\r\n]+$"; ""))
       end' \
      ${lib.escapeShellArg baseConfigFile} > "$temporary"

    mv "$temporary" "$RUNTIME_DIRECTORY/config.json"
    trap - EXIT
  '';
in
{
  options.services.amadeus = {
    enable = lib.mkEnableOption "Amadeus Telegram to Pi RPC bridge";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${system}.default;
      defaultText = lib.literalExpression "inputs.amadeus.packages.\${pkgs.system}.default";
      description = "Amadeus package to run.";
    };

    user = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "amadeus";
      description = "Existing user that runs the service. The default null value runs it as root.";
    };

    configFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/secrets/amadeus.json";
      description = "Runtime path to an Amadeus JSON configuration file.";
    };

    settings = lib.mkOption {
      type = lib.types.attrsOf lib.types.anything;
      default = { };
      example = lib.literalExpression ''
        {
          telegram.allowedUserIds = [ 123456789 ];
          pi = {
            command = "pi";
            args = [ ];
          };
        }
      '';
      description = "Amadeus settings serialized as JSON in the Nix store.";
    };

    telegramBotTokenFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/secrets/amadeus-telegram-bot-token";
      description = "Optional runtime path to a Telegram Bot Token that overrides settings or configFile.";
    };

    piPackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.pi-coding-agent;
      defaultText = lib.literalExpression "pkgs.pi-coding-agent";
      description = "Pi package available to the service.";
    };

    extraPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
      example = lib.literalExpression "[ pkgs.git ]";
      description = "Extra commands available to Pi tools.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = usesConfigFile != usesSettings;
        message = "Set exactly one of services.amadeus.configFile or services.amadeus.settings.";
      }
    ];

    systemd.services.amadeus = {
      description = "Amadeus Telegram to Pi RPC bridge";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];

      path = [ cfg.piPackage ] ++ cfg.extraPackages;
      environment.HOME = "/var/lib/amadeus";
      preStart = lib.mkIf usesTokenFile ''
        ${buildRuntimeConfig}
      '';

      serviceConfig = {
        Type = "simple";
        User = lib.mkIf (cfg.user != null) cfg.user;
        StateDirectory = "amadeus";
        StateDirectoryMode = "0700";
        RuntimeDirectory = "amadeus";
        RuntimeDirectoryMode = "0700";
        WorkingDirectory = "/var/lib/amadeus";
        ExecStart = lib.escapeShellArgs [
          (lib.getExe cfg.package)
          "--config"
          configFile
        ];
        LoadCredential = lib.mkIf usesTokenFile [
          "telegram-bot-token:${cfg.telegramBotTokenFile}"
        ];
        Restart = "on-failure";
        RestartSec = 5;
        UMask = "0077";
      };
    };
  };
}
