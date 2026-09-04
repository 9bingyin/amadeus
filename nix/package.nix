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
      ../scripts
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
    bun build plugins/memory/index.ts \
      --target=node \
      --outfile=memory-plugin.js
    bun build scripts/migrate-memory-daily.ts \
      --compile \
      --outfile=amadeus-memory-migrate
  '';

  postInstall = ''
    install -Dm644 telegram-plugin.js \
      "$out/share/amadeus/plugins/telegram.js"
    install -Dm644 memory-plugin.js \
      "$out/share/amadeus/plugins/memory.js"
    install -Dm755 amadeus-memory-migrate \
      "$out/bin/amadeus-memory-migrate"
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
