{
  self,
  pkgs,
  nodeFor,
  piFor,
  toolchainPackages,
  toolchainFor,
}:
let
  node = nodeFor pkgs;
  pi = piFor pkgs;
  toolchain = toolchainFor pkgs;
  selectorEnv.PI_ENV_AGENT_DIR_SCRIPT = "${../setup/agent-dir.sh}";
  runtimeEnv = {
    PI_ENV_NODE_BIN = "${node}/bin/node";
    NODE_EXECUTABLE = "${node}/bin/node";
    PI_PACKAGE_DIR = "${pi}/lib/pi/node_modules/@earendil-works/pi-coding-agent";
    PI_ENV_PI_EXECUTABLE = pkgs.lib.getExe pi;
  };
  setupApp = pkgs.writeShellApplication {
    name = "pi-env-setup";
    runtimeInputs = [
      toolchain
      pkgs.nix
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
      pkgs.git
      pkgs.coreutils
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
  packages = {
    default = toolchain;
    inherit toolchain pi;
  };
  apps = {
    default = {
      type = "app";
      program = pkgs.lib.getExe setupApp;
    };
    setup = {
      type = "app";
      program = pkgs.lib.getExe setupApp;
    };
    bootstrap = {
      type = "app";
      program = pkgs.lib.getExe bootstrapApp;
    };
    verify-install = {
      type = "app";
      program = pkgs.lib.getExe verifyInstallApp;
    };
  };
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
    PI_ENV_SOURCE = self;
    PI_ENV_SETUP_SCRIPT = ../setup.sh;
    PI_ENV_NODE_BIN = "${node}/bin/node";
  } (builtins.readFile ./check-setup.sh);
  devShells.default = pkgs.mkShell (
    runtimeEnv
    // {
      packages = toolchainPackages pkgs;
    }
  );
}
