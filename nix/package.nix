{
  bun2nix,
  lib,
}:
(bun2nix.mkDerivation {
  pname = "amadeus";
  version = "unstable";

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../bun.lock
      ../package.json
      ../tsconfig.json
      ../src
      ../plugins
    ];
  };
  module = "src/index.ts";
  bunCompileToBytecode = false;
  removeBunBuildFlags = [ "--minify" ];

  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ./bun.nix;
  };

  postBuild = ''
    bun build plugins/telegram/index.ts \
      --target=node \
      --outfile=telegram-plugin.js
  '';

  postInstall = ''
    install -Dm644 telegram-plugin.js \
      "$out/share/amadeus/plugins/telegram.js"
  '';
}).overrideAttrs
  (old: {
    meta = old.meta // {
      description = "Telegram to Pi RPC private chat bridge";
      homepage = "https://github.com/9bingyin/amadeus";
      license = lib.licenses.mit;
      platforms = [
        "x86_64-linux"
        "aarch64-linux"
      ];
    };
  })
