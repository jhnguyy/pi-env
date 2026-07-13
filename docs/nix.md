# Nix support

Nub is the primary path for reproducible `pi-env` JavaScript setup. Nix remains supported for host/runtime provisioning and machines where Home Manager or nix-manager should own system tools and shell configuration.

With local Nix, the only bootstrap prerequisite is Nix with flakes enabled. The flake supplies baseline host tools, and setup uses Nub for Node resolution, JavaScript dependencies, and script orchestration.

The flake supports Linux and macOS on `x86_64` and `aarch64`.

## Choosing a setup path

| Environment | Command | Meaning |
| --- | --- | --- |
| Fresh machine with local Nix + flakes | `nix run github:jhnguyy/pi-env#bootstrap -- ~/pi-env` | Use local Nix to provide `git`, clone, and run setup. |
| Existing checkout with local Nix | `./setup.sh` or `nix run .#setup` | Plain setup auto-detects Nix and tries the setup app. |
| Externally Nix-managed runtime/container | `./setup.sh` | Consume already-provisioned tools when `PI_ENV_CONFIG_MANAGED_BY_NIX=1`; do not invoke local Nix. |
| Persistent user-profile tools | `nix profile install .#toolchain`, then `nix run .#setup` or `./setup.sh --nix-managed` | Install the toolchain into the user profile, then hydrate mutable repo/user state. |

`--use-nix` means “invoke local Nix now” and re-execs `nix run .#setup`. Use it only when you want failure instead of fallback if the current user cannot realize Nix store paths.

`--nix-managed` means “Nix/Home Manager/nix-manager already provided host tools or owns shell/terminal config.” It does not call `nix run`; it uses the existing `nub`, `node`, and `git` on `PATH` while still allowing Nub to resolve the project Node.

Node selection prefers `PI_ENV_NODE_BIN`, then a usable `NODE_EXECUTABLE`, then Nub's project Node. Nix-managed setup may use the host `PATH` before portable fallback probes. The executable policy lives in [`setup/node-runtime.sh`](../setup/node-runtime.sh).

Source-owned setup behavior lives in [`setup.sh`](../setup.sh), [`setup/`](../setup), and [`flake.nix`](../flake.nix).

## Ownership boundaries

Handled deterministically:

- Nix pins the host toolchain through [`flake.lock`](../flake.lock).
- Nub pins repo JavaScript dependencies through [`lock.yaml`](../lock.yaml).
- Managed pi settings are merged from [`setup/config/managed-settings.json`](../setup/config/managed-settings.json) without overwriting machine-local settings.

Intentionally mutable/local:

- `~/.pi/agent/auth.json`
- sessions
- provider/model choices
- local-only extensions
- machine-specific Ghostty overrides

Nix-managed environments set `PI_ENV_CONFIG_MANAGED_BY_NIX=1`, so later direct `./setup.sh` runs skip duplicate PATH/tmux/Ghostty writes. They can also set `PI_ENV_CLI_MANAGED_BY_NIX=1` so setup does not overwrite a Nix-managed `~/.local/bin/pi`.

## Optional Home Manager module

The flake exposes a Home Manager module for hosts where you want pi-env shell/config pieces declared through Nix while keeping the source config in this repo. In Nix-managed shells, avoid auto-activating generic `nvm` Node builds ahead of the Nix toolchain; if `nvm` is present, source it with `--no-use` and run `nvm use` only intentionally.

```nix
{
  imports = [ inputs.pi-env.homeManagerModules.default ];

  pi-env = {
    enable = true;
    installTools = true;
    shell.enable = true;
    tmux.enable = true;
    ghostty.enable = false; # enable on GUI hosts
  };
}
```

The module can install the baseline toolchain, set the Nix ownership environment, add pi paths to the session PATH, and own tmux/Ghostty config when enabled.

## Validation

Use the flake apps/checks for Nix-backed validation and [`package.json`](../package.json) scripts for Nub-backed validation. Keep command details in those sources rather than duplicating them here.

## What remains outside Nix

Mutable user state and repo-local JavaScript dependency hydration remain script-owned. See [`setup.sh`](../setup.sh), [`setup/`](../setup), and [`scripts/`](../scripts).
