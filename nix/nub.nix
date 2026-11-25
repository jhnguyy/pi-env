{ pkgs, nub }:
let
  # The pinned release still embeds vulnerable quinn-proto and zip versions.
  # Remove this override when its upstream lock includes the fixes. Keep the
  # patched lock local so evaluating cargoDeps does not build the source first.
  lockFile = ./nub-Cargo.lock;
in
nub.packages.${pkgs.stdenv.hostPlatform.system}.default.overrideAttrs (previous: {
  patches = (previous.patches or [ ]) ++ [ ../patches/nub-0.11.1-security.patch ];
  postPatch = (previous.postPatch or "") + ''
    cp ${lockFile} Cargo.lock
  '';
  cargoDeps = pkgs.rustPlatform.importCargoLock { inherit lockFile; };
})
