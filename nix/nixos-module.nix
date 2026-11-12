{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.amadeus;
  stateDirectory = "/var/lib/amadeus";
  credentialSource = lib.replaceStrings [ "%" ] [ "%%" ] cfg.configFile;
in
{
  options.services.amadeus = {
    enable = lib.mkEnableOption "Amadeus personal assistant";
    package = lib.mkPackageOption pkgs "amadeus" { };
    user = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "amadeus";
      description = ''
        Existing user that runs the service. The default null value runs it as root.
        Agent tools have the full permissions of this user; the workspace is not a sandbox.
      '';
    };
    configFile = lib.mkOption {
      type = lib.types.str;
      example = "/run/secrets/amadeus.json";
      description = ''
        Absolute runtime path to the application JSON configuration, including literal
        Telegram and provider credentials. Keep this file outside the Nix store.
        systemd loads a private credential copy on each start; the state directory is unchanged.
        Credentials are not expanded from environment variables.
      '';
    };
    extraPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
      example = lib.literalExpression "[ pkgs.git pkgs.ripgrep ]";
      description = "Extra commands available to Agent tools, scheduled scripts and MCP servers.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = lib.hasPrefix "/" cfg.configFile;
        message = "services.amadeus.configFile must be an absolute runtime path.";
      }
    ];
    systemd.services.amadeus = {
      description = "Amadeus personal assistant";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];
      path = [
        cfg.package
        pkgs.bash
        pkgs.coreutils
      ]
      ++ cfg.extraPackages;
      environment = {
        AMADEUS_HOME = stateDirectory;
        HOME = stateDirectory;
      };
      serviceConfig = {
        User = lib.mkIf (cfg.user != null) cfg.user;
        StateDirectory = "amadeus";
        StateDirectoryMode = "0700";
        WorkingDirectory = stateDirectory;
        LoadCredential = [ "config.json:${credentialSource}" ];
        ExecStart = "${lib.getExe cfg.package} %d/config.json";
        Restart = "on-failure";
        RestartSec = 5;
        UMask = "0077";
      };
    };
  };
}
