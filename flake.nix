{
  description = "Portable Nix toolchain and Home Manager helpers for pi-env";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      pkgsFor = system: import nixpkgs { inherit system; };
      nodeFor = pkgs: if pkgs ? nodejs_22 then pkgs.nodejs_22 else pkgs.nodejs;
      toolchainPackages = pkgs: [
        pkgs.git
        pkgs.gh
        (nodeFor pkgs)
        pkgs.neovim
        pkgs.ripgrep
        pkgs.tmux
      ];
      toolchainFor = pkgs: pkgs.symlinkJoin {
        name = "pi-env-toolchain";
        paths = toolchainPackages pkgs;
        meta = {
          description = "Baseline command-line tools for setting up and developing pi-env";
          platforms = systems;
        };
      };
      setupAppFor = pkgs: pkgs.writeShellApplication {
        name = "pi-env-setup";
        runtimeInputs = toolchainPackages pkgs;
        text = ''
          if [ ! -x ./setup.sh ] || [ ! -f ./package.json ]; then
            echo "pi-env setup app must be run from a pi-env checkout." >&2
            echo "Clone the repo, cd into it, then run: nix run .#setup" >&2
            exit 2
          fi
          exec ./setup.sh "$@"
        '';
      };
      verifyInstallAppFor = pkgs: pkgs.writeShellApplication {
        name = "pi-env-verify-install";
        runtimeInputs = toolchainPackages pkgs;
        text = ''
          if [ ! -f ./package.json ]; then
            echo "pi-env verify app must be run from a pi-env checkout." >&2
            exit 2
          fi
          exec npm run verify:install
        '';
      };
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = pkgsFor system;
          toolchain = toolchainFor pkgs;
        in
        {
          default = toolchain;
          toolchain = toolchain;
        });

      apps = forAllSystems (system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = {
            type = "app";
            program = "${setupAppFor pkgs}/bin/pi-env-setup";
          };
          setup = {
            type = "app";
            program = "${setupAppFor pkgs}/bin/pi-env-setup";
          };
          verify-install = {
            type = "app";
            program = "${verifyInstallAppFor pkgs}/bin/pi-env-verify-install";
          };
        });

      checks = forAllSystems (system:
        let
          pkgs = pkgsFor system;
        in
        {
          setup-tests = pkgs.runCommand "pi-env-setup-tests" {
            nativeBuildInputs = [
              (nodeFor pkgs)
              pkgs.bash
              pkgs.coreutils
              pkgs.gnugrep
            ];
          } ''
            cp -R ${self} source
            chmod -R u+w source
            cd source
            bash setup/__tests__/path-profile.test.sh
            bash setup/__tests__/managed-settings.test.sh
            bash setup/__tests__/nix-managed-config.test.sh
            node -e 'JSON.parse(require("fs").readFileSync("package.json", "utf8")); JSON.parse(require("fs").readFileSync("flake.lock", "utf8"));'
            touch "$out"
          '';
        });

      devShells = forAllSystems (system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShell {
            packages = toolchainPackages pkgs;

            shellHook = ''
              echo "pi-env dev shell"
              echo "  node: $(node --version 2>/dev/null || echo missing)"
              echo "  npm:  $(npm --version 2>/dev/null || echo missing)"
              echo "Run ./setup.sh to install/update the user-local pi CLI and register this package."
            '';
          };
        });

      homeManagerModules.default = { config, lib, pkgs, ... }:
        let
          cfg = config.pi-env;
        in
        {
          options.pi-env = {
            enable = lib.mkEnableOption "pi-env host integration";

            installTools = lib.mkOption {
              type = lib.types.bool;
              default = true;
              description = "Install the pi-env baseline CLI toolchain into the Home Manager profile.";
            };

            shell.enable = lib.mkOption {
              type = lib.types.bool;
              default = true;
              description = "Add user-local binary directories used by pi-env setup to the shell PATH.";
            };

            tmux.enable = lib.mkOption {
              type = lib.types.bool;
              default = true;
              description = "Enable Home Manager tmux and source the pi-env tmux config.";
            };

            ghostty.enable = lib.mkOption {
              type = lib.types.bool;
              default = false;
              description = "Install the pi-env Ghostty config and themes. Enable only on GUI hosts.";
            };
          };

          config = lib.mkIf cfg.enable (lib.mkMerge [
            (lib.mkIf cfg.installTools {
              home.packages = toolchainPackages pkgs;
            })

            (lib.mkIf (cfg.shell.enable || cfg.tmux.enable || cfg.ghostty.enable) {
              home.sessionVariables.PI_ENV_CONFIG_MANAGED_BY_NIX = "1";
            })

            (lib.mkIf cfg.shell.enable {
              home.sessionPath = [
                "$HOME/.local/bin"
                "$HOME/.pi/agent/bin"
              ];
            })

            (lib.mkIf cfg.tmux.enable {
              programs.tmux = {
                enable = lib.mkDefault true;
                extraConfig = lib.mkAfter ''
                  source-file ${self}/setup/tmux.conf
                '';
              };
            })

            (lib.mkIf cfg.ghostty.enable {
              home.file = {
                ".config/ghostty/config".source = "${self}/ghostty/config";
                ".config/ghostty/themes/pi-env-gruvbox-dark".source = "${self}/ghostty/themes/pi-env-gruvbox-dark";
                ".config/ghostty/themes/pi-env-gruvbox-light".source = "${self}/ghostty/themes/pi-env-gruvbox-light";
              };
            })
          ]);
        };
    };
}
