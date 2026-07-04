# pi-env prerequisites

The flake is the source of truth for the local-Nix toolchain. On a fresh machine with local Nix, `nix run github:jhnguyy/pi-env#bootstrap -- ~/pi-env` supplies `git` before cloning. From an existing checkout with local Nix, plain `./setup.sh` automatically tries `nix run .#setup`; install `.#toolchain` only when you want the tools persisted in your user profile.

In externally Nix-managed runtimes, such as containers or hosts where Home Manager/nix-manager already provisions the toolchain, plain `./setup.sh` detects `PI_ENV_CONFIG_MANAGED_BY_NIX=1` and consumes current tools without invoking `nix run`. Use `./setup.sh --nix-managed` only to force that behavior manually.

For portable fallback, `setup.sh` is the source of truth: it checks required commands, reports recommended tools for the detected environment, and does not install system packages automatically. Plain `./setup.sh` uses current `PATH` tools by design.

See [`nix.md`](nix.md) for Linux/macOS support, the optional Home Manager module, setup modes, and what stays managed by `pi-env`.
