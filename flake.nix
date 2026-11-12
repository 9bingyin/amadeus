{
  description = "Amadeus personal assistant";

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
        { pkgs, ... }:
        {
          treefmt = {
            projectRootFile = "flake.nix";
            settings.global.excludes = [
              ".test_home/**"
              ".amadeus_test_new/**"
            ];
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
    };
}
