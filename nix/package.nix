{
  lib,
  buildGo127Module,
}:
buildGo127Module {
  pname = "amadeus";
  version = "0-unstable-2026-09-23";

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../cmd
      ../internal
      ../go.mod
      ../go.sum
    ];
  };

  vendorHash = "sha256-yWKqQ8GKog2bcomSoAsxpxsbLGGcPgWbk7ocU3QgaYs=";

  subPackages = [ "cmd/amadeus" ];

  env.CGO_ENABLED = "0";

  meta = {
    description = "Personal assistant";
    homepage = "https://github.com/9bingyin/amadeus";
    license = lib.licenses.mit;
    mainProgram = "amadeus";
  };
}
