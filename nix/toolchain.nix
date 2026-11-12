{
  hunk,
  nixpkgs,
  nub,
  pi,
}:
let
  systems = [
    "aarch64-darwin"
    "aarch64-linux"
    "x86_64-linux"
  ];
  pkgsFor =
    system:
    import nixpkgs {
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
  piVersion =
    (builtins.fromJSON (builtins.readFile "${pi}/packages/coding-agent/package.json")).version;
  packagesFor =
    pkgs:
    let
      node =
        let
          package = builtins.getAttr nodeAttr pkgs;
        in
        assert pkgs.lib.assertMsg (pkgs.lib.versionAtLeast package.version nodeMinimum)
          "Locked ${nodeAttr} is below engines.node (${manifest.engines.node}); update nixpkgs";
        package;
      # setup/templates/tmux.conf uses tmux 3.8 theme colours and its default status format.
      tmux =
        assert pkgs.lib.assertMsg (pkgs.lib.versionAtLeast pkgs.tmux.version "3.8")
          "Locked tmux ${pkgs.tmux.version} is below the 3.8 baseline; update nixpkgs";
        pkgs.tmux;
      piPackage =
        assert pkgs.lib.assertMsg (builtins.all (name: manifest.devDependencies.${name} == piVersion) [
          "@earendil-works/pi-agent-core"
          "@earendil-works/pi-ai"
          "@earendil-works/pi-coding-agent"
          "@earendil-works/pi-tui"
        ]) "Pi development dependencies must match the upstream Pi flake";
        pkgs.callPackage (pi + "/nix/package.nix") {
          source = pi;
          nodejs_22 = node;
        };
      nubPackage =
        let
          package = nub.packages.${pkgs.stdenv.hostPlatform.system}.default;
        in
        assert pkgs.lib.assertMsg (
          manifest.packageManager == "nub@${package.version}"
        ) "Nub flake must match package.json#packageManager";
        package;
      hunkPackage = hunk.packages.${pkgs.stdenv.hostPlatform.system}.hunk;
      atuin = import ./atuin.nix { inherit pkgs; };
      toolsPackages = [
        hunkPackage
        node
        nubPackage
        pkgs.coreutils
        pkgs.findutils
        pkgs.gawk
        pkgs.gh
        pkgs.git
        pkgs.gnugrep
        pkgs.gnused
        pkgs.ncurses
        pkgs.neovim
        pkgs.ripgrep
        tmux
      ];
      toolchainPackages = toolsPackages ++ [ piPackage ];
      package =
        name: paths:
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
    in
    {
      inherit atuin node tmux toolchainPackages;
      hunk = hunkPackage;
      pi = piPackage;
      toolchain = package "pi-env-toolchain" toolchainPackages;
      tools = package "pi-env-tools" toolsPackages;
    };
in
{
  inherit packagesFor pkgsFor systems;
}
