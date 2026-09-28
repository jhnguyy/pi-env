# pi-env prerequisites

[`setup.sh`](../setup.sh) is the executable authority for prerequisite checks, setup modes, Node/Nub selection, and fallback behavior.

Nub is the canonical JavaScript toolchain boundary. Setup runs one frozen dependency installation and reports its result. It does not delete `node_modules` or retry after an installation failure.

Local-Nix setup requires Nix with flakes. Externally managed setup consumes the provisioned toolchain. Portable setup checks host commands but does not install system packages.

Setup choices and ownership boundaries are documented in [`nix.md`](nix.md). Source-owned configuration and scripts live in [`package.json`](../package.json), [`nub.jsonc`](../nub.jsonc), [`flake.nix`](../flake.nix), and [`setup/`](../setup).

## Portable Nub recovery

If portable setup finds an obsolete or missing Nub, run `./setup.sh --portable --bootstrap-nub`. This opt-in path runs before Node discovery and dependency installation. It uses the installed Nub if its version matches `package.json#packageManager`. Otherwise it downloads the exact pinned Nub release archive over HTTPS and checks its SHA-256 digest against the reviewed value in [`setup/bootstrap-nub.sh`](../setup/bootstrap-nub.sh). It extracts only `bin/nub` after verification, checks its version outside the repository, and places it first on PATH for this setup run. The private copy is removed on exit. The bootstrap step does not replace a host executable, persist its PATH change, delete `node_modules`, or retry a failed dependency install. Normal setup can still update shell profiles unless `--no-path` is set. Each new Nub version needs reviewed archive digests for each supported platform.

This path requires `curl`, `tar`, `mktemp`, and `sha256sum` or `shasum`. It supports glibc Linux and macOS on x86_64 and arm64. The released binary must run on the host. A verified binary can still fail if its dynamic loader or libraries are missing. Use the Nix-provisioned route on such hosts. A Nix-managed environment cannot use portable bootstrap, even if `--portable` is given. A failed automatic Nix setup still follows the existing setup fallback policy; portable bootstrap is never implicit. Do not use it as a retry for unrelated install failures.
