{
  nixpkgs,
  nub,
  pi,
}:
let
  systems = [
    "x86_64-linux"
    "aarch64-linux"
    "x86_64-darwin"
    "aarch64-darwin"
  ];
  pkgsFor =
    system:
    import (if system == "x86_64-darwin" then pi.inputs.nixpkgs-darwin-x64 else nixpkgs) {
      inherit system;
    };
  manifest = builtins.fromJSON (builtins.readFile ../package.json);
  nodeMatch = builtins.match ">=([0-9]+)\\.([0-9]+)\\.([0-9]+)" manifest.engines.node;
  nodeMinimum =
    if nodeMatch == null then
      throw "Unsupported engines.node: ${manifest.engines.node}"
    else
      builtins.concatStringsSep "." nodeMatch;
  nodeAttr = "nodejs_${builtins.head nodeMatch}";
  nodeFor =
    pkgs:
    let
      node = builtins.getAttr nodeAttr pkgs;
    in
    assert pkgs.lib.assertMsg (pkgs.lib.versionAtLeast node.version nodeMinimum)
      "Locked ${nodeAttr} is below engines.node (${manifest.engines.node}); update nixpkgs";
    node;
  piVersion =
    (builtins.fromJSON (builtins.readFile "${pi}/packages/coding-agent/package.json")).version;
  piFor =
    pkgs:
    let
      patched = builtins.hasAttr "@earendil-works/pi-coding-agent@${piVersion}" (
        manifest.patchedDependencies or { }
      );
      # Patch the inner workspace build, not the install-only outer derivation.
      # Keep metadata on the original source to avoid import-from-derivation.
      buildStdenv = pkgs.stdenv // {
        mkDerivation =
          args:
          pkgs.stdenv.mkDerivation (
            args
            // pkgs.lib.optionalAttrs (patched && (args.pname or "") == "pi-workspace-packages") {
              patches = (args.patches or [ ]) ++ [
                (../patches + "/pi-command-overrides-${piVersion}.patch")
              ];
            }
          );
      };
      package = pi.packages.${pkgs.stdenv.hostPlatform.system}.default.override {
        nodejs_22 = nodeFor pkgs;
        stdenv = buildStdenv;
      };
    in
    assert pkgs.lib.assertMsg (builtins.all (name: manifest.devDependencies.${name} == piVersion) [
      "@earendil-works/pi-coding-agent"
      "@earendil-works/pi-agent-core"
      "@earendil-works/pi-ai"
      "@earendil-works/pi-tui"
    ]) "Pi development dependencies must match the upstream Pi flake";
    package.overrideAttrs (old: {
      installCheckPhase = (old.installCheckPhase or "") + ''
        ${nodeFor pkgs}/bin/node ${../scripts}/verify-pi-runtime.mjs \
          "$out/lib/pi/node_modules/@earendil-works/pi-coding-agent" ${../package.json}
      '';
    });
  nubFor =
    pkgs:
    let
      # Reuse Nub's upstream packaging with Pi's supported Intel macOS input.
      nubOutputs =
        if pkgs.stdenv.hostPlatform.system == "x86_64-darwin" then
          (import "${nub}/flake.nix").outputs {
            self = nub;
            nixpkgs = pi.inputs.nixpkgs-darwin-x64;
          }
        else
          nub;
      # Carry the NFS lock correction locally without changing locked inputs.
      package = nubOutputs.packages.${pkgs.stdenv.hostPlatform.system}.default.overrideAttrs (old: {
        patches = (old.patches or [ ]) ++ [
          ./patches/nub-gvs-lock-read-access.patch
          ./patches/nub-store-lock-read-access.patch
        ];
      });
    in
    assert pkgs.lib.assertMsg (
      manifest.packageManager == "nub@${package.version}"
    ) "Nub flake must match package.json#packageManager";
    package;
  toolsPackages = pkgs: [
    pkgs.git
    pkgs.gh
    (nodeFor pkgs)
    (nubFor pkgs)
    pkgs.coreutils
    pkgs.findutils
    pkgs.gawk
    pkgs.gnugrep
    pkgs.gnused
    pkgs.neovim
    pkgs.ripgrep
    pkgs.tmux
    pkgs.flock
  ];
  toolchainPackages = pkgs: toolsPackages pkgs ++ [ (piFor pkgs) ];
  packageFor =
    pkgs: name: paths:
    pkgs.symlinkJoin {
      inherit name paths;
      meta = {
        description = "Baseline command-line tools for setting up and developing pi-env";
        license = with pkgs.lib.licenses; [
          asl20
          gpl2Only
          gpl3Plus
          isc
          mit
          unlicense
        ];
        platforms = systems;
      };
    };
  toolsFor = pkgs: packageFor pkgs "pi-env-tools" (toolsPackages pkgs);
  toolchainFor = pkgs: packageFor pkgs "pi-env-toolchain" (toolchainPackages pkgs);
in
{
  inherit
    systems
    pkgsFor
    nodeFor
    piFor
    toolsFor
    toolchainPackages
    toolchainFor
    ;
}
