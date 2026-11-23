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
      packages.buildTools
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
      # Keep Docker's root default for this single-user build environment.
      # An explicit User makes docker exec resolve Nix's symlinked NSS files
      # outside the container, which recent Docker versions reject.
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
        "org.opencontainers.image.description" = "Shared pi-env build tools with Nix, without interactive workbench tools";
        "org.opencontainers.image.source" = "https://github.com/jhnguyy/pi-env";
      };
    };
  };
}
