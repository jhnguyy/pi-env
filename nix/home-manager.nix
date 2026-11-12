{
  self,
  packagesFor,
}:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.pi-env;
  packages = packagesFor pkgs;
  managedPiLauncher = import ./pi-launcher.nix {
    inherit pkgs packages;
  };
in
{
  options.pi-env = {
    enable = lib.mkEnableOption "pi-env host integration";

    installTools = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Install the pi-env baseline CLI toolchain into the Home Manager profile.";
    };

    checkoutPath = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = lib.literalExpression ''"''${config.home.homeDirectory}/src/pi-env"'';
      description = ''
        Absolute path to a writable pi-env checkout. When set, Home Manager owns
        ~/.local/bin/pi. Setup registers the checkout's Pi resources separately;
        the checkout and its dependencies are not installed by Nix.
      '';
    };

    shell.enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Add user-local binary directories used by pi-env setup to the shell PATH.";
    };

    shell.bashPrompt.enable = lib.mkEnableOption "the pi-env ANSI Bash prompt (owns PS1)";

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

    homeManager.sync = {
      enable = lib.mkEnableOption "pi-env setup checks of this Home Manager flake against the pi-env checkout. `./setup.sh --sync-home-manager` updates the input and switches";

      flake = lib.mkOption {
        type = lib.types.str;
        default = "${config.xdg.configHome}/home-manager";
        defaultText = lib.literalExpression ''"''${config.xdg.configHome}/home-manager"'';
        description = "Directory of the Home Manager flake that consumes pi-env.";
      };

      input = lib.mkOption {
        type = lib.types.str;
        default = "pi-env";
        description = "Name of the pi-env input in that flake.";
      };
    };
  };

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      (lib.mkIf cfg.installTools {
        home.packages = packages.toolchainPackages;
      })

      (lib.mkIf (cfg.installTools || cfg.checkoutPath != null) {
        home.sessionVariables = {
          PI_ENV_NODE_BIN = "${packages.node}/bin/node";
          NODE_EXECUTABLE = "${packages.node}/bin/node";
          PI_PACKAGE_DIR = "${packages.pi}/lib/pi/node_modules/@earendil-works/pi-coding-agent";
          PI_ENV_PI_EXECUTABLE = lib.getExe packages.pi;
        };
      })

      (lib.mkIf (cfg.shell.enable || cfg.shell.bashPrompt.enable || cfg.tmux.enable || cfg.ghostty.enable) {
        home.sessionVariables.PI_ENV_CONFIG_MANAGED_BY_NIX = "1";
      })

      (lib.mkIf (cfg.checkoutPath != null) {
        assertions = [
          {
            assertion = lib.hasPrefix "/" cfg.checkoutPath;
            message = "pi-env.checkoutPath must be an absolute checkout path string.";
          }
        ];
        home.file.".local/bin/pi".source = lib.getExe managedPiLauncher;
        home.sessionVariables.PI_ENV_CLI_MANAGED_BY_NIX = "1";
      })

      (lib.mkIf cfg.homeManager.sync.enable {
        home.sessionVariables = {
          PI_ENV_HOME_MANAGER_FLAKE = cfg.homeManager.sync.flake;
          PI_ENV_HOME_MANAGER_INPUT = cfg.homeManager.sync.input;
        };
      })

      (lib.mkIf cfg.shell.enable {
        home.sessionPath = [
          "$HOME/.local/bin"
          "$HOME/.pi/agent/bin"
        ];
      })

      (lib.mkIf cfg.shell.bashPrompt.enable {
        assertions = [
          {
            assertion = config.programs.bash.enable;
            message = "pi-env.shell.bashPrompt.enable requires programs.bash.enable.";
          }
        ];
        programs.bash.initExtra = lib.mkAfter ''
          source ${self}/setup/templates/bash-prompt.sh
        '';
      })

      (lib.mkIf cfg.tmux.enable {
        programs.tmux = {
          enable = lib.mkDefault true;
          extraConfig = lib.mkAfter ''
            source-file ${self}/setup/templates/tmux.conf
          '';
        };
      })

      (lib.mkIf cfg.ghostty.enable {
        home.file = lib.mkIf pkgs.stdenv.hostPlatform.isDarwin {
          "Library/Application Support/com.mitchellh.ghostty/config".source = "${self}/ghostty/config";
        };
        xdg.configFile = {
          "ghostty/config" = lib.mkIf (!pkgs.stdenv.hostPlatform.isDarwin) {
            source = "${self}/ghostty/config";
          };
          "ghostty/themes/pi-env-gruvbox-dark".source =
            "${self}/ghostty/themes/pi-env-gruvbox-dark";
          "ghostty/themes/pi-env-gruvbox-light".source =
            "${self}/ghostty/themes/pi-env-gruvbox-light";
        };
      })
    ]
  );
}
