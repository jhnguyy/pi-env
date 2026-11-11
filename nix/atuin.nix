{ pkgs }:
let
  release = {
    version = "18.24.6";
    artifacts = {
      aarch64-darwin = {
        target = "aarch64-apple-darwin";
        sha256 = "756b7d2f8cb919d29888ea52b2fb19aba92ed52ddbca456839088ccc63257f5b";
      };
      aarch64-linux = {
        target = "aarch64-unknown-linux-musl";
        sha256 = "0dcc72a06738f913040cdd990298a37d9ef062c8849026d0a3410d2def4c6bf7";
      };
      x86_64-darwin = {
        target = "x86_64-apple-darwin";
        sha256 = "3d0126fdf00a079882b89d059f246488af700c4a8092a9400a92ce05688fdba4";
      };
      x86_64-linux = {
        target = "x86_64-unknown-linux-musl";
        sha256 = "49b6e7a93cd6d8c77ee02bdb0eef0acff4c80ddaa0efb00c8179285771043698";
      };
    };
  };
  artifact = release.artifacts.${pkgs.stdenv.hostPlatform.system};
  hookSha256 = builtins.replaceStrings [ "\n" ] [ "" ] (builtins.readFile ../setup/atuin-pi-hook.sha256);
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
    env HOME="$TMPDIR/atuin-home" \
      ATUIN_CONFIG_DIR="$TMPDIR/atuin-config" \
      ATUIN_HOME="$TMPDIR/atuin-data" \
      PI_CODING_AGENT_DIR="$TMPDIR/atuin-agent" \
      "$out/bin/atuin" hook install pi
    install -Dm644 "$TMPDIR/atuin-agent/extensions/atuin.ts" "$out/share/atuin/pi/atuin.ts"
    printf '%s  %s\n' '${hookSha256}' "$out/share/atuin/pi/atuin.ts" | sha256sum --check --status
    runHook postInstall
  '';
  meta = {
    description = "Atuin client pinned for native Pi threads, MCP, and output capture";
    license = pkgs.lib.licenses.mit;
    platforms = builtins.attrNames release.artifacts;
    mainProgram = "atuin";
  };
}
