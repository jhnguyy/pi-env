{
  description = "Portable Nix toolchain and Home Manager helpers for pi-env";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nub = {
      url = "github:nubjs/nub/v0.9.6";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    pi = {
      url = "github:badlogic/pi-mono/v1.0.4";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      nub,
      pi,
    }:
    let
      toolchain = import ./nix/toolchain.nix { inherit nixpkgs nub pi; };
      perSystem = nixpkgs.lib.genAttrs toolchain.systems (
        system:
        import ./nix/outputs.nix {
          inherit self;
          inherit (toolchain)
            nodeFor
            piFor
            toolchainPackages
            toolchainFor
            ;
          pkgs = toolchain.pkgsFor system;
        }
      );
    in
    {
      packages = nixpkgs.lib.mapAttrs (_: outputs: outputs.packages) perSystem;
      apps = nixpkgs.lib.mapAttrs (_: outputs: outputs.apps) perSystem;
      checks = nixpkgs.lib.mapAttrs (_: outputs: outputs.checks) perSystem;
      devShells = nixpkgs.lib.mapAttrs (_: outputs: outputs.devShells) perSystem;
      homeManagerModules.default = import ./nix/home-manager.nix {
        inherit self;
        inherit (toolchain) toolchainPackages nodeFor piFor;
      };
    };
}
