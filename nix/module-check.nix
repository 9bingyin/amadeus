{
  lib,
  pkgs,
  nixosModules,
  nixosSystem,
}:
let
  package = pkgs.writeShellScriptBin "amadeus" "exit 0";
  eval =
    settings:
    nixosSystem {
      system = pkgs.stdenv.hostPlatform.system;
      modules = [
        nixosModules.default
        {
          services.amadeus = settings // {
            enable = true;
            inherit package;
          };
          fileSystems."/" = {
            device = "fake";
            fsType = "ext4";
          };
          boot.loader.grub.enable = false;
          system.stateVersion = "26.05";
        }
      ];
    };
  root = eval { configFile = "/run/secrets/amadeus.json"; };
  existing = eval {
    user = "existing-user";
    configFile = "/run/secrets/private % config.json";
    extraPackages = [ pkgs.git ];
  };
  relative = eval { configFile = "relative/config.json"; };
  rootService = root.config.systemd.services.amadeus;
  userService = existing.config.systemd.services.amadeus;
in
assert !(rootService.serviceConfig ? User);
assert !(root.config.users.users ? amadeus);
assert !(existing.config.users.users ? existing-user);
assert userService.serviceConfig.User == "existing-user";
assert rootService.serviceConfig.StateDirectory == "amadeus";
assert rootService.serviceConfig.StateDirectoryMode == "0700";
assert rootService.serviceConfig.UMask == "0077";
assert rootService.environment.HOME == "/var/lib/amadeus";
assert rootService.environment.AMADEUS_HOME == "/var/lib/amadeus";
assert rootService.serviceConfig.WorkingDirectory == "/var/lib/amadeus";
assert rootService.serviceConfig.LoadCredential == [ "config.json:/run/secrets/amadeus.json" ];
assert
  userService.serviceConfig.LoadCredential == [ "config.json:/run/secrets/private %% config.json" ];
assert rootService.serviceConfig.ExecStart == "${lib.getExe package} %d/config.json";
assert !(rootService.serviceConfig ? EnvironmentFile);
assert !(root.options.services.amadeus ? settings);
assert !(root.options.services.amadeus ? environmentFile);
assert lib.elem pkgs.git userService.path;
assert lib.any (
  assertion:
  !assertion.assertion
  && assertion.message == "services.amadeus.configFile must be an absolute runtime path."
) relative.config.assertions;
pkgs.runCommand "amadeus-nixos-module-check" { } ''
  touch "$out"
''
