# pi-env prerequisites

[`setup.sh`](../setup.sh) is the executable authority for prerequisite checks, setup modes, Node/Nub selection, and fallback behavior.

Nub is the canonical JavaScript toolchain boundary. Setup requires the exact Nub version in `package.json#packageManager` and stops before dependency cleanup when the installed version differs. Local-Nix setup requires Nix with flakes. Externally managed setup consumes the provisioned toolchain. Portable setup checks host commands but does not install system packages.

Setup choices and ownership boundaries are documented in [`nix.md`](nix.md). Source-owned versions and scripts live in [`package.json`](../package.json), [`nub.lock`](../nub.lock), [`flake.nix`](../flake.nix), and [`setup/`](../setup). Repository-specific Nub runtime and install policy lives in [`nub.jsonc`](../nub.jsonc).
