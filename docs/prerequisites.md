# pi-env prerequisites

Nub is the canonical JavaScript toolchain boundary for pi-env. It owns project Node resolution, dependency installation, and script orchestration through `package.json#devEngines.runtime`, `.node-version`, `package.json#packageManager`, `lock.yaml`, and `nub run`.

The flake remains the source of truth for local-Nix host provisioning. On a fresh machine with local Nix, `nix run github:jhnguyy/pi-env#bootstrap -- ~/pi-env` supplies `git` before cloning. From an existing checkout with local Nix, plain `./setup.sh` automatically tries `nix run .#setup`; install `.#toolchain` only when you want the tools persisted in your user profile.

In externally Nix-managed runtimes, such as containers or hosts where Home Manager/nix-manager already provisions the toolchain, plain `./setup.sh` detects `PI_ENV_CONFIG_MANAGED_BY_NIX=1` and consumes current tools without invoking `nix run`. Use `./setup.sh --nix-managed` only to force that behavior manually.

For portable fallback, `setup.sh` is the source of truth: it checks required commands, reports recommended tools for the detected environment, and does not install system packages automatically. Plain `./setup.sh` uses current host tools by design. If no usable Node is available but Nix is installed, setup reports the Nix setup command as the next step instead of trying to repair the system package state itself.

See [`nix.md`](nix.md) for Linux/macOS support, the optional Home Manager module, setup modes, and what stays managed by `pi-env`.
