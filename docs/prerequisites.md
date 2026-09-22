# pi-env prerequisites

[`setup.sh`](../setup.sh) is the executable authority for prerequisite checks, setup modes, Node/Nub selection, and fallback behavior.

Nub is the canonical JavaScript toolchain boundary. Setup runs one frozen dependency installation and reports its result. It does not delete `node_modules` or retry after an installation failure.

Local-Nix setup requires Nix with flakes. Externally managed setup consumes the provisioned toolchain. Portable setup checks host commands but does not install system packages.

Setup choices and ownership boundaries are documented in [`nix.md`](nix.md). Source-owned configuration and scripts live in [`package.json`](../package.json), [`nub.jsonc`](../nub.jsonc), [`flake.nix`](../flake.nix), and [`setup/`](../setup).
