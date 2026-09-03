{
  description = "Amadeus Telegram to Pi RPC bridge";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    treefmt-nix.url = "github:numtide/treefmt-nix";
    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      treefmt-nix,
      bun2nix,
      ...
    }:
    flake-utils.lib.eachSystem
      [
        "x86_64-linux"
        "aarch64-linux"
      ]
      (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          bun2nixPackage = bun2nix.packages.${system}.default;
          amadeus = pkgs.callPackage ./nix/package.nix {
            bun2nix = bun2nixPackage;
          };
          treefmtEval = treefmt-nix.lib.evalModule pkgs {
            projectRootFile = "flake.nix";
            programs = {
              nixfmt.enable = true;
              prettier.enable = true;
            };
          };
          moduleSystem = nixpkgs.lib.nixosSystem {
            inherit system;
            modules = [
              self.nixosModules.default
              {
                services.amadeus = {
                  enable = true;
                  configFile = "/run/secrets/amadeus.json";
                };
              }
            ];
          };
          moduleService = moduleSystem.config.systemd.services.amadeus;
          secretModuleSystem = nixpkgs.lib.nixosSystem {
            inherit system;
            modules = [
              self.nixosModules.default
              {
                services.amadeus = {
                  enable = true;
                  telegramBotTokenFile = "/run/secrets/amadeus-telegram-bot-token";
                  settings = {
                    telegram = {
                      allowedUserIds = [ 123456789 ];
                      streamResponses = false;
                    };
                    pi = {
                      command = "pi";
                      args = [ ];
                    };
                  };
                };
              }
            ];
          };
          secretModuleService = secretModuleSystem.config.systemd.services.amadeus;
          secretPreStart = builtins.head secretModuleService.serviceConfig.ExecStartPre;
          directTokenModuleSystem = nixpkgs.lib.nixosSystem {
            inherit system;
            modules = [
              self.nixosModules.default
              {
                services.amadeus = {
                  enable = true;
                  user = "existing-user";
                  settings.telegram = {
                    botToken = "direct-token";
                    allowedUserIds = [ 123456789 ];
                  };
                };
              }
            ];
          };
          directTokenService = directTokenModuleSystem.config.systemd.services.amadeus;
          directTokenConfigFile = builtins.elemAt (nixpkgs.lib.splitString "--config " directTokenService.serviceConfig.ExecStart) 1;
          moduleCheck =
            assert !(moduleService.serviceConfig ? User);
            assert !(moduleService.serviceConfig ? Group);
            assert !(moduleSystem.config.users.users ? amadeus);
            assert !(moduleSystem.config.users.groups ? amadeus);
            assert moduleService.serviceConfig.StateDirectory == "amadeus";
            assert !(moduleService.serviceConfig ? LoadCredential);
            assert !(moduleService.serviceConfig ? ProtectSystem);
            assert !(moduleService.serviceConfig ? PrivateTmp);
            assert nixpkgs.lib.hasSuffix "--config /run/secrets/amadeus.json"
              moduleService.serviceConfig.ExecStart;
            assert
              secretModuleService.serviceConfig.LoadCredential == [
                "telegram-bot-token:/run/secrets/amadeus-telegram-bot-token"
              ];
            assert nixpkgs.lib.hasSuffix "--config /run/amadeus/config.json"
              secretModuleService.serviceConfig.ExecStart;
            assert !(directTokenService.serviceConfig ? LoadCredential);
            assert directTokenService.serviceConfig.User == "existing-user";
            assert !(directTokenService.serviceConfig ? Group);
            assert nixpkgs.lib.hasPrefix "/nix/store/" directTokenConfigFile;
            pkgs.runCommand "amadeus-nixos-module-check" { } ''
              mkdir -p runtime credentials
              printf '%s\n' 'secret-token' > credentials/telegram-bot-token

              RUNTIME_DIRECTORY="$PWD/runtime" \
                CREDENTIALS_DIRECTORY="$PWD/credentials" \
                ${secretPreStart}

              ${nixpkgs.lib.getExe pkgs.jq} -e '
                .telegram.botToken == "secret-token" and
                .telegram.allowedUserIds == [123456789] and
                .telegram.streamResponses == false and
                .pi.command == "pi"
              ' runtime/config.json > /dev/null

              ${nixpkgs.lib.getExe pkgs.jq} -e '
                .telegram.botToken == "direct-token" and
                .telegram.allowedUserIds == [123456789]
              ' ${directTokenConfigFile} > /dev/null

              touch "$out"
            '';
        in
        {
          packages = {
            default = amadeus;
            inherit amadeus;
          };

          checks = {
            formatting = treefmtEval.config.build.check self;
            package = amadeus;
            nixos-module = moduleCheck;
          };

          formatter = treefmtEval.config.build.wrapper;

          devShells.default = pkgs.mkShell {
            packages = [
              pkgs.bun
              bun2nixPackage
            ];
          };
        }
      )
    // {
      nixosModules = {
        default = import ./nix/nixos-module.nix { inherit self; };
        amadeus = self.nixosModules.default;
      };
    };
}
