{ pkgs, node }:
let
  release = {
    version = "0.11.1";
    artifacts = {
      aarch64-darwin = {
        target = "darwin-arm64";
        sha256 = "14ecb987300fdc4ad8e9cd8db59c9fea4d31973922b0a920507887bfe1f570cb";
      };
      aarch64-linux = {
        target = "linux-arm64";
        sha256 = "9a27560a48d3cc8eed07e6aaae8506e16271727f31ea5d810c77db613da2ceaf";
      };
      x86_64-linux = {
        target = "linux-x64";
        sha256 = "312dcb5b4da9f274bc3ae8e2a8a6eb5ab2302176083dacd6bf3d819d72011567";
      };
    };
  };
  artifact = release.artifacts.${pkgs.stdenv.hostPlatform.system};
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "nub";
  inherit (release) version;
  src = pkgs.fetchurl {
    url = "https://github.com/nubjs/nub/releases/download/v${release.version}/nub-${artifact.target}.tar.gz";
    sha256 = artifact.sha256;
  };
  sourceRoot = ".";
  nativeBuildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.autoPatchelfHook ];
  buildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.stdenv.cc.cc.lib ];
  dontConfigure = true;
  dontBuild = true;
  dontStrip = true;
  installPhase = ''
    runHook preInstall
    install -Dm755 bin/nub "$out/bin/nub"
    ln -s nub "$out/bin/nubx"
    ln -s nub "$out/bin/nubr"
    runHook postInstall
  '';
  doInstallCheck = true;
  nativeInstallCheckInputs = [ node ];
  installCheckPhase = ''
    runHook preInstallCheck
    export HOME="$TMPDIR/nub-home" XDG_CACHE_HOME="$TMPDIR/nub-cache" NUB_SELF_SHIM=0
    test "$("$out/bin/nub" --version)" = "v${release.version}"
    cat > "$TMPDIR/smoke.ts" <<'EOF'
    const value: number = 42;
    if (value !== 42) throw new Error("Nub TypeScript runner failed");
    EOF
    "$out/bin/nub" --no-check "$TMPDIR/smoke.ts"
    runHook postInstallCheck
  '';
  meta = {
    description = "Official precompiled Nub release; no local Rust build";
    license = pkgs.lib.licenses.mit;
    platforms = builtins.attrNames release.artifacts;
    mainProgram = "nub";
  };
}
