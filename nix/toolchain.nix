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
    assert pkgs.lib.assertMsg (builtins.all (name: manifest.devDependencies.${name} == piVersion) [
      "@earendil-works/pi-coding-agent"
      "@earendil-works/pi-agent-core"
      "@earendil-works/pi-ai"
      "@earendil-works/pi-tui"
    ]) "Pi development dependencies must match the upstream Pi flake";
    pi.packages.${pkgs.system}.default.override { nodejs_22 = nodeFor pkgs; };
  nubFor =
    pkgs:
    let
      # Reuse Nub's upstream packaging with Pi's supported Intel macOS input.
      nubOutputs =
        if pkgs.system == "x86_64-darwin" then
          (import "${nub}/flake.nix").outputs {
            self = nub;
            nixpkgs = pi.inputs.nixpkgs-darwin-x64;
          }
        else
          nub;
      # Carry the NFS lock correction locally without changing locked inputs.
      package = nubOutputs.packages.${pkgs.system}.default.overrideAttrs (old: {
        patches = (old.patches or [ ]) ++ [ ./patches/nub-gvs-lock-read-access.patch ];
      });
    in
    assert pkgs.lib.assertMsg (
      manifest.packageManager == "nub@${package.version}"
    ) "Nub flake must match package.json#packageManager";
    package;
  toolchainPackages = pkgs: [
    pkgs.git
    pkgs.gh
    (nodeFor pkgs)
    (nubFor pkgs)
    (piFor pkgs)
    pkgs.coreutils
    pkgs.findutils
    pkgs.gawk
    pkgs.gnugrep
    pkgs.gnused
    pkgs.neovim
    pkgs.ripgrep
    pkgs.tmux
  ];
  toolchainFor =
    pkgs:
    pkgs.symlinkJoin {
      name = "pi-env-toolchain";
      paths = toolchainPackages pkgs;
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
in
{
  inherit
    systems
    pkgsFor
    nodeFor
    piFor
    toolchainPackages
    toolchainFor
    ;
}
