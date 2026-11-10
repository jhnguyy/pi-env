{
  description = "Portable Nix toolchain and Home Manager helpers for pi-env";

  inputs = {
    hunk.url = "github:modem-dev/hunk/v0.24.1";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nub = {
      url = "github:nubjs/nub/v0.10.0";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    pi = {
      url = "github:earendil-works/pi/v1.5.1";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      hunk,
      nixpkgs,
      nub,
      pi,
      self,
    }:
    let
      toolchain = import ./nix/toolchain.nix { inherit hunk nixpkgs nub pi; };
      perSystem = nixpkgs.lib.genAttrs toolchain.systems (
        system:
        let
          pkgs = toolchain.pkgsFor system;
        in
        import ./nix/outputs.nix {
          inherit pkgs self;
          packages = toolchain.packagesFor pkgs;
        }
      );
    in
    {
      apps = nixpkgs.lib.mapAttrs (_: outputs: outputs.apps) perSystem;
      checks = nixpkgs.lib.mapAttrs (_: outputs: outputs.checks) perSystem;
      devShells = nixpkgs.lib.mapAttrs (_: outputs: outputs.devShells) perSystem;
      homeManagerModules.default = import ./nix/home-manager.nix {
        inherit self;
        inherit (toolchain) packagesFor;
      };
      lib.atuin.captureSettings = import ./nix/atuin-settings.nix;
      lib.themes.gruvbox = {
        palettes = builtins.mapAttrs (_: file: (builtins.fromJSON (builtins.readFile file)).vars) {
          dark = ./themes/gruvbox-dark.json;
          light = ./themes/gruvbox-light.json;
        };
        ghostty.theme = "light:${self}/ghostty/themes/pi-env-gruvbox-light,dark:${self}/ghostty/themes/pi-env-gruvbox-dark";
      };
      packages = nixpkgs.lib.mapAttrs (_: outputs: outputs.packages) perSystem;
    };
}
