{ pkgs }:
let
  release = builtins.fromJSON (builtins.readFile ../setup/atuin-release.json);
  artifact = release.artifacts.${pkgs.stdenv.hostPlatform.system};
  name = "atuin-${artifact.target}";
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "atuin";
  inherit (release) version;
  src = pkgs.fetchurl {
    url = "https://github.com/atuinsh/atuin/releases/download/v${release.version}/${name}.tar.gz";
    sha256 = artifact.sha256;
  };
  sourceRoot = name;
  dontConfigure = true;
  dontBuild = true;
  dontStrip = true;
  installPhase = ''
    runHook preInstall
    install -Dm755 atuin "$out/bin/atuin"
    install -Dm644 LICENSE "$out/share/licenses/atuin/LICENSE"
    runHook postInstall
  '';
  meta = {
    description = "Atuin client pinned for native Pi threads, MCP, and output capture";
    license = pkgs.lib.licenses.mit;
    platforms = builtins.attrNames release.artifacts;
    mainProgram = "atuin";
  };
}
