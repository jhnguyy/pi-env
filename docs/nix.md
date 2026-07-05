# Nix support

Nix is the primary path for reproducible `pi-env` setup. The portable shell setup remains as a fallback for machines where Nix is unavailable.

With Nix, the only bootstrap prerequisite is Nix with flakes enabled. The flake supplies the baseline toolchain, and setup uses Nub for JavaScript dependencies and script orchestration.

The flake supports Linux and macOS on `x86_64` and `aarch64`:

- `x86_64-linux`
- `aarch64-linux`
- `x86_64-darwin`
- `aarch64-darwin`

## Choosing a setup path

| Environment | Command | Meaning |
| --- | --- | --- |
| Fresh machine with local Nix + flakes | `nix run github:jhnguyy/pi-env#bootstrap -- ~/pi-env` | Use local Nix to provide `git`, clone, and run setup. |
| Existing checkout with local Nix | `./setup.sh` or `nix run .#setup` | Plain setup auto-detects Nix and tries the setup app. |
| Externally Nix-managed runtime/container | `./setup.sh` | Consume already-provisioned tools when `PI_ENV_CONFIG_MANAGED_BY_NIX=1`; do not invoke local Nix. |
| Persistent user-profile tools | `nix profile install .#toolchain`, then `nix run .#setup` or `./setup.sh --nix-managed` | Install the toolchain into the user profile, then hydrate mutable repo/user state. |

The bootstrap app brings `git` from the flake toolchain before cloning, so a fresh local-Nix host does not need a separate Git install.

Plain `./setup.sh` auto-detects local Nix and tries `nix run .#setup` before falling back to portable setup. Set `PI_ENV_AUTO_NIX=0` or pass `--portable` to skip that automatic Nix attempt.

`--use-nix` means “invoke local Nix now” and re-execs `nix run .#setup`. Use it only when you want failure instead of fallback if the current user cannot realize Nix store paths.

`--nix-managed` means “Nix/Home Manager/nix-manager already provided the toolchain or owns shell/terminal config.” It does not call `nix run`; it uses the existing `nub`, `node`, and `git` on `PATH` unless `PI_ENV_NODE_BIN` pins Node explicitly. This mode is selected automatically when `PI_ENV_CONFIG_MANAGED_BY_NIX=1` is already present.

`nix run .#setup` runs `./setup.sh --nix-managed` from the checkout and exports `PI_ENV_NODE_BIN` to the flake-provided Node executable. Nix-managed setup skips shell profile, tmux, and Ghostty writes because those can be handled by a higher-priority Nix configuration. If `PI_ENV_CLI_MANAGED_BY_NIX=1`, setup also leaves `~/.local/bin/pi` alone and only verifies that the checkout's locked pi package exists after `nub install`.

## Toolchain

The flake's `toolchainPackages` is the source of truth for the dev shell, installable `.#toolchain` package, setup app runtime, bootstrap app runtime, and Nix setup checks.

Node's major version is derived from `.node-version`, then resolved through nixpkgs as `nodejs_<major>`. Keep `.node-version`, `.nvmrc`, and `package.json#engines.node` aligned when moving to a new Node LTS line. The exact Nix patch version comes from `flake.lock`; the package engine range should express the supported LTS floor rather than a patch that the locked nixpkgs cannot provide. `nub run check:node` enforces that the local pins match and that `package.json#engines.node` stays on the same major line.

## Deterministic boundaries

Handled deterministically:

- Nix pins the host toolchain through `flake.lock`.
- `nub install --frozen-lockfile` pins repo JavaScript dependencies while preserving the incumbent lockfile.
- The `pi` wrapper points at the locked `@earendil-works/pi-coding-agent` installed in this checkout's `node_modules` and executes it with the Node selected during setup; setup no longer performs a second independent package install for the CLI.
- Managed pi settings are merged from `setup/config/managed-settings.json` without overwriting machine-local settings.

Intentionally mutable/local:

- `~/.pi/agent/auth.json`
- sessions
- provider/model choices
- local-only extensions
- machine-specific Ghostty overrides

## Setup modes

```bash
./setup.sh                  # auto: try local Nix setup, then fallback when needed
./setup.sh --use-nix        # local Nix: re-exec nix run .#setup from a checkout, no fallback
./setup.sh --nix-managed    # external Nix: force provisioned tools/config ownership
./setup.sh --portable       # skip auto-Nix and use current PATH tools
./setup.sh --no-terminal    # skip tmux/Ghostty setup
./setup.sh --no-path        # skip shell profile PATH edits
./setup.sh --no-repo-hooks  # skip git hook setup
```

Setup selects a usable Node before running Node/Nub install steps. The selection contract is explicit: `PI_ENV_NODE_BIN` wins, Nix-managed setup trusts PATH Node first, portable setup prefers already working host Node, and Nub's project Node is a fallback. If no usable Node is found and Nix is available, setup reports `./setup.sh --use-nix` or an externally Nix-managed toolchain as the next step.

Nix-managed environments set `PI_ENV_CONFIG_MANAGED_BY_NIX=1`, so later direct `./setup.sh` runs skip duplicate PATH/tmux/Ghostty writes. They can also set `PI_ENV_CLI_MANAGED_BY_NIX=1` so setup does not overwrite a Nix-managed `~/.local/bin/pi`. Granular environment flags are supported:

- `PI_ENV_CLI_MANAGED_BY_NIX=1`
- `PI_ENV_SKIP_PATH_PROFILE=1`
- `PI_ENV_SKIP_TMUX=1`
- `PI_ENV_SKIP_GHOSTTY=1`

## Validation

Use the flake apps/checks for Nix-backed validation and `package.json` scripts for Nub-backed validation. Keep command details in those sources rather than duplicating them here.

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

The module can:

- install the baseline toolchain into the Home Manager profile
- add `~/.local/bin` and `~/.pi/agent/bin` to the session PATH
- set `PI_ENV_CONFIG_MANAGED_BY_NIX=1` so later setup runs skip duplicate PATH/tmux/Ghostty writes
- enable Home Manager tmux and source `setup/templates/tmux.conf`
- install Ghostty config/themes from `ghostty/` when `ghostty.enable = true`

## What remains outside Nix

These pieces remain scripts because they operate on mutable user state or repo-local JavaScript dependencies:

| Script | Why it remains |
| --- | --- |
| `setup.sh`, `setup/main.sh` | Portable entrypoint, `--use-nix` convenience re-exec, and Nix app target. |
| `setup/install.sh` | Runs `nub install --frozen-lockfile`, verifies the locked pi package, and writes the user-local `pi` wrapper only when a higher-priority Nix config is not managing it. |
| `setup/configure.sh` | Registers the pi package, merges managed settings, bootstraps agent context, and installs repo hooks. |
| `setup/apply-managed-settings.mjs` | Safely merges managed pi settings without overwriting machine-local state. |
| `scripts/build-extensions.*`, `scripts/verify-install.mjs` | Repo build and verification logic. |
| `scripts/restart-lsp-daemon.sh` | Install-time LSP daemon hygiene. |

The old non-deterministic standalone pi CLI npm install has been removed. The main remaining non-Nix operation is `nub install --frozen-lockfile`, which is deterministic through the project lockfile but still fetches npm artifacts unless cached.
