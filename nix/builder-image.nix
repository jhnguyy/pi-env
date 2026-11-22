{ packages, pkgs }:
let
  settings = pkgs.writeTextDir "etc/nix/nix.conf" ''
    experimental-features = nix-command flakes
    build-users-group =
    sandbox = false
    substituters = https://cache.nixos.org
  '';
  builder-root = pkgs.buildEnv {
    name = "pi-env-builder-root";
    paths = [
      packages.toolchain
      pkgs.bashInteractive
      pkgs.cacert
      pkgs.curl
      pkgs.gnutar
      pkgs.gzip
      pkgs.nix
      pkgs.xz
      pkgs.zstd
      pkgs.dockerTools.usrBinEnv
      pkgs.dockerTools.fakeNss
      settings
    ];
    pathsToLink = [
      "/bin"
      "/usr/bin"
      "/etc"
    ];
  };
in
{
  inherit builder-root;
  builder-image = pkgs.dockerTools.streamLayeredImage {
    name = "pi-env-builder";
    tag = "ci";
    contents = [ builder-root ];
    includeNixDB = true;
    extraCommands = ''
      mkdir -p root workspace tmp
      chmod 1777 tmp
    '';
    config = {
      # This is a single-user build environment, not the deployed application.
      User = "0:0";
      WorkingDir = "/workspace";
      Cmd = [ "/bin/bash" ];
      Env = [
        "PATH=/bin:/usr/bin"
        "HOME=/root"
        "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
        "NIX_SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
      ];
      Labels = {
        "org.opencontainers.image.title" = "pi-env Nix builder";
        "org.opencontainers.image.description" = "Curated pi-env toolchain with Nix for image builds";
        "org.opencontainers.image.source" = "https://github.com/jhnguyy/pi-env";
      };
    };
  };
}
