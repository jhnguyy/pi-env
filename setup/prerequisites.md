# pi-env prerequisites

The flake is the source of truth for the Nix-managed toolchain. Use `nix develop`, `nix run .#setup`, or install `.#toolchain` instead of keeping a separate prerequisite list in this document.

For portable fallback, `setup.sh` is the source of truth: it checks required commands, reports recommended tools for the detected environment, and does not install system packages automatically.

See [`nix.md`](nix.md) for Linux/macOS support, the optional Home Manager module, setup modes, and what stays managed by `pi-env`.
