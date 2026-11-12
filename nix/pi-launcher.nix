{
  pkgs,
  packages,
}:
pkgs.writeShellApplication {
  name = "pi";
  runtimeInputs = [ packages.tmux ];
  runtimeEnv = {
    DEFAULT_PI_PACKAGE_DIR = "${packages.pi}/lib/pi/node_modules/@earendil-works/pi-coding-agent";
    # The packaged Pi executable owns its entrypoint; this field is portable-only.
    PI_PACKAGE_ENTRY = "";
    PI_EXECUTABLE = pkgs.lib.getExe packages.pi;
    NODE_BIN = "${packages.node}/bin/node";
  };
  text = builtins.readFile ../setup/templates/pi-launcher.sh;
}
