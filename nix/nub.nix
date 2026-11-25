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
  # Official binaries lack cargo-auditable metadata. These release-source locks
  # provide conservative scan inventories, not proof of compiled dependencies.
  workspaceLock = pkgs.fetchurl {
    url = "https://raw.githubusercontent.com/nubjs/nub/v${release.version}/Cargo.lock";
    sha256 = "ea11e3595b995a503b6d536d7045f1ca8d251cec6ad63fc88f8b23185ae5dc4b";
  };
  nativeLock = pkgs.fetchurl {
    url = "https://raw.githubusercontent.com/nubjs/nub/v${release.version}/crates/nub-native/Cargo.lock";
    sha256 = "c6c468d50b40da0c8ebd814a18823d7ae0deff0c32cc6ab2a37d4dca6fa2643b";
  };
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
    install -Dm644 ${workspaceLock} "$out/share/nub/${release.version}/source/Cargo.lock"
    install -Dm644 ${nativeLock} "$out/share/nub/${release.version}/native/Cargo.lock"
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
