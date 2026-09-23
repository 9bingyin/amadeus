{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.amadeus;
  format = pkgs.formats.json { };
  stateDirectory = "/var/lib/amadeus";
  configSource =
    if cfg.configFile != null then cfg.configFile else format.generate "amadeus.json" cfg.settings;
in
{
  options.services.amadeus = {
    enable = lib.mkEnableOption "Amadeus personal assistant";

    package = lib.mkPackageOption pkgs "amadeus" { };

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
      description = "Runtime path to an Amadeus JSON configuration file. Copied into the state directory on start.";
    };

    settings = lib.mkOption {
      type = format.type;
      default = { };
      example = lib.literalExpression ''
        {
          model = "assistant";
          models.assistant = {
            provider = "default";
            id = "gpt-5-mini";
            contextWindowTokens = 128000;
          };
          providers.default = {
            api = "openai-responses";
            apiKey = "replace-with-api-key";
          };
          telegram = {
            enabled = true;
            allowedUserIDs = [ 123456789 ];
          };
        }
      '';
      description = "Amadeus settings serialized as JSON. Literal secrets in this set are stored in the Nix store. Refer to environmentFile with \${NAME} instead.";
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/secrets/amadeus.env";
      description = "Runtime systemd EnvironmentFile. apiKey, telegram.botToken, and MCP headers and env can reference these variables as \${NAME}. The file stays outside the Nix store.";
    };

    extraPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
      example = lib.literalExpression "[ pkgs.git ]";
      description = "Extra commands available to the assistant, including bash tool commands.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = (cfg.configFile != null) != (cfg.settings != { });
        message = "Set exactly one of services.amadeus.configFile or services.amadeus.settings.";
      }
    ];

    systemd.services.amadeus = {
      description = "Amadeus personal assistant";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];

      path = [
        pkgs.bash
        pkgs.coreutils
      ]
      ++ cfg.extraPackages;
      environment = {
        AMADEUS_HOME = stateDirectory;
        HOME = stateDirectory;
      };
      preStart = ''
        set -eu
        umask 077

        temporary="$STATE_DIRECTORY/config.json.tmp"
        trap 'rm -f "$temporary"' EXIT
        cp ${lib.escapeShellArg configSource} "$temporary"
        mv "$temporary" "$STATE_DIRECTORY/config.json"
        trap - EXIT
      '';

      serviceConfig = {
        User = lib.mkIf (cfg.user != null) cfg.user;
        StateDirectory = "amadeus";
        StateDirectoryMode = "0700";
        WorkingDirectory = stateDirectory;
        ExecStart = lib.getExe cfg.package;
        EnvironmentFile = lib.mkIf (cfg.environmentFile != null) cfg.environmentFile;
        Restart = "on-failure";
        RestartSec = 5;
        UMask = "0077";
      };
    };
  };
}
