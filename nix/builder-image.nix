{ packages, pkgs }:
let
  settings = pkgs.writeTextDir "etc/nix/nix.conf" ''
    experimental-features = nix-command flakes
    build-users-group =
    sandbox = false
    substituters = https://cache.nixos.org
  '';
  # Node's complete notice includes its bundled third-party notices; the generic
  # MIT text or the Nix package's license identifier is not a substitute.
  nodeNotice = pkgs.runCommand "node-notice-${packages.node.version}" {
    nativeBuildInputs = [ pkgs.gnutar pkgs.xz ];
  } ''
    mkdir -p "$out/usr/share/licenses/nodejs"
    tar -xOf ${packages.node.src} node-v${packages.node.version}/LICENSE \
      > "$out/usr/share/licenses/nodejs/LICENSE"
  '';
  root = name: tools: extra: pkgs.buildEnv {
    inherit name;
    paths = [ tools pkgs.dockerTools.usrBinEnv pkgs.dockerTools.fakeNss nodeNotice ] ++ extra;
    pathsToLink = [ "/bin" "/usr/bin" "/etc" "/usr/share/licenses" ];
  };
  builder-root = root "pi-env-builder-root" packages.buildTools [ settings ];
  runtime-root = root "pi-env-runtime-root" packages.runtimeTools [];
  image = name: contents: builder: pkgs.dockerTools.streamLayeredImage {
    inherit name;
    tag = "ci";
    contents = [ contents ];
    includeNixDB = builder;
    extraCommands = ''
      # Docker resolves users outside the container. Real NSS files avoid its
      # rejection of /etc links into the Nix store, including on docker exec.
      cp -aL etc etc-copy
      rm -rf etc
      mv etc-copy etc
      printf 'agent:x:1000:1000:pi-env:/home/agent:/bin/bash\n' >> etc/passwd
      printf 'agent:x:1000:\n' >> etc/group
      mkdir -p root workspace opt/pi-env home/agent tmp
      chmod 1777 tmp
    '';
    fakeRootCommands = ''
      chown -R 1000:1000 home/agent opt/pi-env
    '';
    config = {
      User = if builder then "0:0" else "1000:1000";
      WorkingDir = if builder then "/workspace" else "/opt/pi-env";
      Cmd = [ "/bin/bash" ];
      Env = [
        "PATH=/bin:/usr/bin"
        "HOME=${if builder then "/root" else "/home/agent"}"
        "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
        "NIX_SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
      ];
      Labels = {
        "org.opencontainers.image.title" = name;
        "org.opencontainers.image.source" = "https://github.com/jhnguyy/pi-env";
      };
    };
  };
in
{
  inherit builder-root runtime-root;
  builder-image = image "pi-env-builder" builder-root true;
  runtime-image = image "pi-env-runtime" runtime-root false;
  # This is an inventory, not evidence that distribution obligations are met.
  runtime-closure = pkgs.closureInfo { rootPaths = [ runtime-root ]; };
}
