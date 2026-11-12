{
  lib,
  stdenvNoCC,
  bun,
  bash,
  cacert,
  coreutils,
  util-linux,
  which,
  makeBinaryWrapper,
  writableTmpDirAsHomeHook,
  callPackage,
}:
let
  runtimePackages = [
    bun
    bash
    coreutils
    util-linux
    which
  ];
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "amadeus";
  version = "0-unstable-2026-11-13";

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../bun.lock
      ../config.example.json
      (lib.fileset.fileFilter (file: file.hasExt "ts" && !(lib.hasSuffix ".test.ts" file.name)) ../src)
    ];
  };

  node_modules = stdenvNoCC.mkDerivation {
    pname = "${finalAttrs.pname}-node_modules";
    inherit (finalAttrs) version;
    src = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions [
        ../package.json
        ../bun.lock
      ];
    };
    nativeBuildInputs = [
      bun
      writableTmpDirAsHomeHook
    ];
    strictDeps = true;
    impureEnvVars = lib.fetchers.proxyImpureEnvVars;
    env.SSL_CERT_FILE = "${cacert}/etc/ssl/certs/ca-bundle.crt";
    dontConfigure = true;
    buildPhase = ''
      runHook preBuild
      export BUN_INSTALL_CACHE_DIR=$(mktemp -d)
      bun install --production --frozen-lockfile --ignore-scripts --no-progress
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      mv node_modules "$out"
      runHook postInstall
    '';
    dontFixup = true;
    outputHashMode = "recursive";
    outputHash = "sha256-s8Nto/WiUcLm+RWRa8Jhv9qvOzJowQY2lUuRJ5E3guY=";
  };

  nativeBuildInputs = [ makeBinaryWrapper ];
  strictDeps = true;
  dontConfigure = true;
  dontBuild = true;
  installPhase = ''
    runHook preInstall

    libdir="$out/lib/amadeus"
    mkdir -p "$libdir" "$out/bin"
    cp -r src package.json "$libdir/"
    cp -r ${finalAttrs.node_modules} "$libdir/node_modules"
    install -Dm644 config.example.json "$out/share/doc/amadeus/config.example.json"
    makeWrapper ${lib.getExe bun} "$out/bin/amadeus" \
      --add-flags "run $libdir/src/main.ts" \
      --prefix PATH : ${lib.makeBinPath runtimePackages}

    runHook postInstall
  '';

  passthru.tests.smoke = callPackage ./package-check.nix {
    amadeus = finalAttrs.finalPackage;
    inherit runtimePackages;
  };

  meta = {
    description = "Personal AI assistant with durable execution and Telegram support";
    longDescription = ''
      Personal assistant built with Bun and pi-durable, with Telegram messaging,
      persistent conversations, scheduled work, local tools, MCP and Markdown memory.
      Commands run with the privileges of the user running the assistant.
    '';
    homepage = "https://github.com/9bingyin/amadeus";
    license = lib.licenses.mit;
    mainProgram = "amadeus";
    maintainers = [
      {
        name = "9bingyin";
        github = "9bingyin";
        githubId = 37502927;
      }
    ];
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ];
  };
})
