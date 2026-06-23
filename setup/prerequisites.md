# pi-env prerequisites

The flake is the source of truth for the Nix-managed toolchain. On a fresh machine, `nix run github:jhnguyy/pi-env#bootstrap -- ~/pi-env` supplies `git` before cloning. From an existing checkout, use `nix run .#setup` or `./setup.sh --use-nix`; install `.#toolchain` only when you want the tools persisted in your user profile.

For portable fallback, `setup.sh` is the source of truth: it checks required commands, reports recommended tools for the detected environment, and does not install system packages automatically. Plain `./setup.sh` uses current `PATH` tools by design.

See [`nix.md`](nix.md) for Linux/macOS support, the optional Home Manager module, setup modes, and what stays managed by `pi-env`.
