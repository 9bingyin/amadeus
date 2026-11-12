{
  description = "Personal AI assistant with durable execution and Telegram support";

  inputs = {
    nixpkgs.url = "https://channels.nixos.org/nixpkgs-unstable/nixexprs.tar.zst";
    flake-parts = {
      url = "github:hercules-ci/flake-parts";
      inputs.nixpkgs-lib.follows = "nixpkgs";
    };
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    inputs:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [ inputs.treefmt-nix.flakeModule ];
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];

      perSystem =
        { config, pkgs, ... }:
        {
          packages.amadeus = pkgs.callPackage ./nix/package.nix { };
          packages.default = config.packages.amadeus;

          checks = {
            package = config.packages.amadeus.tests.smoke;
            nixos-module = pkgs.callPackage ./nix/module-check.nix {
              inherit (inputs.self) nixosModules;
              inherit (inputs.nixpkgs.lib) nixosSystem;
            };
          };

          treefmt = {
            projectRootFile = "flake.nix";
            programs = {
              nixfmt.enable = true;
              prettier.enable = true;
            };
          };

          devShells.default = pkgs.mkShell {
            packages = with pkgs; [
              bash
              bun
              sqlite
              util-linux
            ];
          };
        };

      flake = {
        overlays.default = final: _prev: {
          amadeus = final.callPackage ./nix/package.nix { };
        };
        nixosModules = {
          amadeus = { pkgs, lib, ... }: {
            imports = [ ./nix/nixos-module.nix ];
            services.amadeus.package = lib.mkDefault (pkgs.callPackage ./nix/package.nix { });
          };
          default = inputs.self.nixosModules.amadeus;
        };
      };
    };
}
