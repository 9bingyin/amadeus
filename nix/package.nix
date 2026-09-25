{
  lib,
  buildGo127Module,
}:
buildGo127Module {
  pname = "amadeus";
  version = "0-unstable-2026-09-25";

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../cmd
      ../internal
      ../go.mod
      ../go.sum
    ];
  };

  vendorHash = "sha256-fnR8D0+EZBkBAQMkzEpFl48psAvmDMSmM8pkArQmAUU=";

  subPackages = [ "cmd/amadeus" ];

  env.CGO_ENABLED = "0";

  meta = {
    description = "Personal assistant";
    homepage = "https://github.com/9bingyin/amadeus";
    license = lib.licenses.mit;
    mainProgram = "amadeus";
  };
}
