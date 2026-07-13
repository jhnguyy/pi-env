# pi-env prerequisites

[`setup.sh`](../setup.sh) is the executable authority for prerequisite checks, setup modes, Node/Nub selection, and fallback behavior.

Nub is the canonical JavaScript toolchain boundary. Local-Nix setup requires Nix with flakes; externally managed setup consumes the provisioned toolchain; portable setup checks host commands but does not install system packages.

Setup choices and ownership boundaries are documented in [`nix.md`](nix.md). Source-owned versions and scripts live in [`package.json`](../package.json), [`lock.yaml`](../lock.yaml), [`flake.nix`](../flake.nix), and [`setup/`](../setup).
