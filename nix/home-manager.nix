{
  self,
  toolchainPackages,
  nodeFor,
  piFor,
}:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.pi-env;
  ghosttyDirectory =
    if pkgs.stdenv.isDarwin then
      "Library/Application Support/com.mitchellh.ghostty"
    else
      ".config/ghostty";
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
        home.packages = toolchainPackages pkgs;
        home.sessionVariables = {
          PI_ENV_NODE_BIN = "${nodeFor pkgs}/bin/node";
          PI_PACKAGE_DIR = "${piFor pkgs}/lib/pi/node_modules/@earendil-works/pi-coding-agent";
          PI_ENV_PI_EXECUTABLE = lib.getExe (piFor pkgs);
        };
      })

      (lib.mkIf (cfg.shell.enable || cfg.tmux.enable || cfg.ghostty.enable) {
        home.sessionVariables.PI_ENV_CONFIG_MANAGED_BY_NIX = "1";
      })

      (lib.mkIf cfg.homeManager.sync.enable {
        home.sessionVariables = {
          PI_ENV_HOME_MANAGER_FLAKE = cfg.homeManager.sync.flake;
          PI_ENV_HOME_MANAGER_INPUT = cfg.homeManager.sync.input;
          PI_ENV_HOME_MANAGER_SESSION_VARS = "${config.home.profileDirectory}/etc/profile.d/hm-session-vars.sh";
        };
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
            source-file ${self}/setup/templates/tmux.conf
          '';
        };
      })

      (lib.mkIf cfg.ghostty.enable {
        home.file = {
          "${ghosttyDirectory}/config".source = "${self}/ghostty/config";
        };
        xdg.configFile = {
          "ghostty/themes/pi-env-gruvbox-dark".source =
            "${self}/ghostty/themes/pi-env-gruvbox-dark";
          "ghostty/themes/pi-env-gruvbox-light".source =
            "${self}/ghostty/themes/pi-env-gruvbox-light";
        };
      })
    ]
  );
}
