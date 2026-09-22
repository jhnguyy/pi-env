# pi-env prerequisites

[`setup.sh`](../setup.sh) is the executable authority for prerequisite checks, setup modes, Node/Nub selection, and fallback behavior.

Nub is the canonical JavaScript toolchain boundary. Setup requires the exact Nub release in `package.json#packageManager` before dependency installation. A toolchain or lock-compatibility failure does not modify `node_modules`. If installation fails against a pre-existing dependency tree, setup does not delete the tree or retry the installation.

Local-Nix setup requires Nix with flakes. Externally managed setup consumes the provisioned toolchain. Portable setup checks host commands but does not install system packages.

Setup choices and ownership boundaries are documented in [`nix.md`](nix.md). Source-owned configuration and scripts live in [`package.json`](../package.json), [`nub.jsonc`](../nub.jsonc), [`flake.nix`](../flake.nix), and [`setup/`](../setup).
