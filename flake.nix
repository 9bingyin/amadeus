{
  description = "Amadeus personal assistant";

  inputs = {
    nixpkgs.url = "https://channels.nixos.org/nixpkgs-unstable/nixexprs.tar.zst";
    flake-parts.url = "github:hercules-ci/flake-parts";
    systems.url = "github:nix-systems/default";
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    inputs:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [ inputs.treefmt-nix.flakeModule ];
      systems = import inputs.systems;

      perSystem =
        {
          config,
          pkgs,
          ...
        }:
        {
          packages.default = pkgs.callPackage ./nix/package.nix { };

          checks = pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
            nixos-module = pkgs.callPackage ./nix/module-check.nix {
              inherit (inputs.self) nixosModules;
              inherit (inputs.nixpkgs.lib) nixosSystem;
            };
          };

          treefmt = {
            projectRootFile = "flake.nix";
            programs = {
              gofmt.enable = true;
              nixfmt.enable = true;
            };
          };

          devShells.default = pkgs.mkShell {
            packages = with pkgs; [
              go_1_27
              golangci-lint
              gopls
              gotools
              goose
              sqlc
              sqlite
              config.treefmt.build.wrapper
            ];
          };
        };

      flake.nixosModules = {
        default =
          {
            pkgs,
            lib,
            ...
          }:
          {
            imports = [ ./nix/nixos-module.nix ];
            services.amadeus.package = lib.mkDefault (pkgs.callPackage ./nix/package.nix { });
          };
        amadeus = inputs.self.nixosModules.default;
      };
    };
}
