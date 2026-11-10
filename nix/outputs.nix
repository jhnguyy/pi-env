{
  packages,
  pkgs,
  self,
}:
let
  inherit (packages) node pi toolchain;
  selectorEnv.PI_ENV_AGENT_DIR_SCRIPT = "${../setup/agent-dir.sh}";
  runtimeEnv = {
    NODE_EXECUTABLE = "${node}/bin/node";
    PI_ENV_NODE_BIN = "${node}/bin/node";
    PI_ENV_PI_EXECUTABLE = pkgs.lib.getExe pi;
    PI_PACKAGE_DIR = "${pi}/lib/pi/node_modules/@earendil-works/pi-coding-agent";
  };
  setupApp = pkgs.writeShellApplication {
    name = "pi-env-setup";
    runtimeInputs = [
      pkgs.nix
      toolchain
    ];
    runtimeEnv =
      runtimeEnv
      // selectorEnv
      // {
        PI_ENV_SETUP_MODE = "local-nix";
        PI_ENV_TOOLCHAIN = "${toolchain}";
      };
    text = builtins.readFile ./setup.sh;
  };
  bootstrapApp = pkgs.writeShellApplication {
    name = "pi-env-bootstrap";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.git
    ];
    runtimeEnv = selectorEnv // {
      PI_ENV_SETUP_COMMAND = pkgs.lib.getExe setupApp;
    };
    text = builtins.readFile ./bootstrap.sh;
  };
  verifyInstallApp = pkgs.writeShellApplication {
    name = "pi-env-verify-install";
    runtimeInputs = [ toolchain ];
    inherit runtimeEnv;
    text = builtins.readFile ./verify-install.sh;
  };
in
{
  apps = {
    bootstrap = {
      type = "app";
      program = pkgs.lib.getExe bootstrapApp;
    };
    default = {
      type = "app";
      program = pkgs.lib.getExe setupApp;
    };
    setup = {
      type = "app";
      program = pkgs.lib.getExe setupApp;
    };
    verify-install = {
      type = "app";
      program = pkgs.lib.getExe verifyInstallApp;
    };
  };
  checks.pi-package = pi;
  checks.setup-tests = pkgs.runCommand "pi-env-setup-tests" {
    nativeBuildInputs = [
      node
      pkgs.bash
      pkgs.coreutils
      pkgs.findutils
      pkgs.gawk
      pkgs.git
      pkgs.gnugrep
      pkgs.gnused
    ];
    PI_ENV_NODE_BIN = "${node}/bin/node";
    PI_ENV_SETUP_SCRIPT = ../setup.sh;
    PI_ENV_SOURCE = self;
  } (builtins.readFile ./check-setup.sh);
  devShells.default = pkgs.mkShell (
    runtimeEnv
    // {
      packages = packages.toolchainPackages;
    }
  );
  packages = {
    default = toolchain;
    inherit (packages) atuin hunk pi tmux toolchain tools;
  };
}
