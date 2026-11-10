{
  description = "Portable Nix toolchain and Home Manager helpers for pi-env";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    hunk.url = "github:modem-dev/hunk/v0.24.1";
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
      self,
      nixpkgs,
      hunk,
      nub,
      pi,
    }:
    let
      toolchain = import ./nix/toolchain.nix { inherit nixpkgs hunk nub pi; };
      perSystem = nixpkgs.lib.genAttrs toolchain.systems (
        system:
        let
          pkgs = toolchain.pkgsFor system;
        in
        import ./nix/outputs.nix {
          inherit self pkgs;
          packages = toolchain.packagesFor pkgs;
        }
      );
    in
    {
      packages = nixpkgs.lib.mapAttrs (_: outputs: outputs.packages) perSystem;
      apps = nixpkgs.lib.mapAttrs (_: outputs: outputs.apps) perSystem;
      checks = nixpkgs.lib.mapAttrs (_: outputs: outputs.checks) perSystem;
      devShells = nixpkgs.lib.mapAttrs (_: outputs: outputs.devShells) perSystem;
      lib.atuin.captureSettings = import ./nix/atuin-settings.nix;
      lib.themes.gruvbox = {
        palettes = builtins.mapAttrs (_: file: (builtins.fromJSON (builtins.readFile file)).vars) {
          dark = ./themes/gruvbox-dark.json;
          light = ./themes/gruvbox-light.json;
        };
        ghostty.theme = "light:${self}/ghostty/themes/pi-env-gruvbox-light,dark:${self}/ghostty/themes/pi-env-gruvbox-dark";
      };
      homeManagerModules.default = import ./nix/home-manager.nix {
        inherit self;
        inherit (toolchain) packagesFor;
      };
    };
}
