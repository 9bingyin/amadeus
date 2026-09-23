{
  lib,
  pkgs,
  nixosModules,
  nixosSystem,
}:
let
  modulePackage = pkgs.writeShellScriptBin "amadeus" "exit 0";
  eval =
    settings:
    nixosSystem {
      system = pkgs.stdenv.hostPlatform.system;
      modules = [
        nixosModules.default
        {
          services.amadeus = settings // {
            enable = true;
            package = modulePackage;
          };
        }
        {
          fileSystems."/" = {
            device = "fake";
            fsType = "ext4";
          };
          boot.loader.grub.enable = false;
          system.stateVersion = "25.11";
        }
      ];
    };
  configFileSystem = eval { configFile = "/run/secrets/amadeus.json"; };
  secretSystem = eval {
    environmentFile = "/run/secrets/amadeus.env";
    settings = {
      model = "assistant";
      providers.default.apiKey = "\${OPENAI_API_KEY}";
      telegram.botToken = "\${TELEGRAM_BOT_TOKEN}";
      telegram.allowedUserIDs = [ 123456789 ];
    };
  };
  directSystem = eval {
    user = "existing-user";
    settings.telegram = {
      botToken = "direct-token";
      allowedUserIDs = [ 123456789 ];
    };
  };
  configFileService = configFileSystem.config.systemd.services.amadeus;
  secretService = secretSystem.config.systemd.services.amadeus;
  directService = directSystem.config.systemd.services.amadeus;
in
assert !(configFileService.serviceConfig ? User);
assert !(configFileSystem.config.users.users ? amadeus);
assert configFileService.serviceConfig.StateDirectory == "amadeus";
assert configFileService.environment.AMADEUS_HOME == "/var/lib/amadeus";
assert !(configFileService.serviceConfig ? EnvironmentFile);
assert configFileService.serviceConfig.ExecStart == lib.getExe modulePackage;
assert secretService.serviceConfig.EnvironmentFile == "/run/secrets/amadeus.env";
assert directService.serviceConfig.User == "existing-user";
assert !(directService.serviceConfig ? EnvironmentFile);
pkgs.runCommand "amadeus-nixos-module-check" { } ''
  mkdir -p state
  STATE_DIRECTORY="$PWD/state" ${lib.head secretService.serviceConfig.ExecStartPre}

  ${lib.getExe pkgs.jq} -e '
    .providers.default.apiKey == "''${OPENAI_API_KEY}" and
    .telegram.botToken == "''${TELEGRAM_BOT_TOKEN}" and
    .telegram.allowedUserIDs == [123456789]
  ' state/config.json > /dev/null

  rm state/config.json
  STATE_DIRECTORY="$PWD/state" ${lib.head directService.serviceConfig.ExecStartPre}
  ${lib.getExe pkgs.jq} -e '
    .telegram.botToken == "direct-token" and
    .telegram.allowedUserIDs == [123456789]
  ' state/config.json > /dev/null

  touch "$out"
''
