# Nix support

Nix is the primary path for reproducible `pi-env` setup. The portable shell setup remains as a fallback for machines where Nix is unavailable.

With Nix, the only bootstrap prerequisite is Nix with flakes enabled. The flake supplies the baseline toolchain, and setup uses the repo `package-lock.json` for JavaScript dependencies.

The flake supports Linux and macOS on `x86_64` and `aarch64`:

- `x86_64-linux`
- `aarch64-linux`
- `x86_64-darwin`
- `aarch64-darwin`

## Fast path

Fresh machine with only Nix installed:

```bash
nix run github:jhnguyy/pi-env#bootstrap -- ~/pi-env
```

Existing checkout:

```bash
nix run .#setup
```

Persistent user-profile tool install:

```bash
nix profile install .#toolchain
./setup.sh --nix-managed
```

`nix run .#setup` runs `./setup.sh --nix-managed` from the checkout. Nix-managed setup skips shell profile, tmux, and Ghostty writes because those are handled by Nix/Home Manager when desired.

## Toolchain

The dev shell and installable `.#toolchain` package include:

- `git`
- Node.js 22 / `npm`
- `neovim`
- `tmux`
- `gh`
- `ripgrep`

## Deterministic boundaries

Handled deterministically:

- Nix pins the host toolchain through `flake.lock`.
- `npm ci` pins repo JavaScript dependencies through `package-lock.json`.
- The `pi` wrapper points at the locked `@earendil-works/pi-coding-agent` installed in this checkout's `node_modules`; setup no longer performs a second independent npm install for the CLI.
- Managed pi settings are merged from `setup/managed-settings.json` without overwriting machine-local settings.

Intentionally mutable/local:

- `~/.pi/agent/auth.json`
- sessions
- provider/model choices
- local-only extensions
- machine-specific Ghostty overrides

## Setup modes

```bash
./setup.sh --nix-managed    # Nix/Home Manager owns shell and terminal config
./setup.sh --portable       # fallback default for non-Nix hosts
./setup.sh --no-terminal    # skip tmux/Ghostty setup
./setup.sh --no-path        # skip shell profile PATH edits
./setup.sh --no-repo-hooks  # skip git hook setup
```

The Home Manager module sets `PI_ENV_CONFIG_MANAGED_BY_NIX=1`, so later direct `./setup.sh` runs skip duplicate PATH/tmux/Ghostty writes. Granular environment flags are also supported:

- `PI_ENV_SKIP_PATH_PROFILE=1`
- `PI_ENV_SKIP_TMUX=1`
- `PI_ENV_SKIP_GHOSTTY=1`

## Validation

Use layered validation depending on what changed:

```bash
# Validate Nix outputs and setup shell tests.
nix flake check

# Validate the Nix-backed setup path from a checkout.
HOME=$(mktemp -d) nix run .#setup

# Validate first-run clone + setup. Override URL for branch/local testing.
HOME=$(mktemp -d) PI_ENV_REPO_URL=file://$PWD nix run .#bootstrap -- /tmp/pi-env-bootstrap-test

# Validate setup shell helpers without Nix.
npm run test:setup

# Validate pi-env install readiness after setup/npm install.
nix run .#verify-install
# equivalent: npm run verify:install

# Full pre-merge gate for code changes, including setup shell tests.
npm run verify
```

## Optional Home Manager module

The flake exposes a Home Manager module for hosts where you want pi-env shell/config pieces declared through Nix while keeping the source config in this repo:

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
- enable Home Manager tmux and source `setup/tmux.conf`
- install Ghostty config/themes from `ghostty/` when `ghostty.enable = true`

## What remains outside Nix

These pieces remain scripts because they operate on mutable user state or repo-local JavaScript dependencies:

| Script | Why it remains |
| --- | --- |
| `setup.sh`, `setup/main.sh` | Portable entrypoint and Nix app target. |
| `setup/install.sh` | Runs `npm ci` and writes the user-local `pi` wrapper into `~/.local/bin`. |
| `setup/configure.sh` | Registers the pi package, merges managed settings, bootstraps agent context, and installs repo hooks. |
| `setup/apply-managed-settings.mjs` | Safely merges managed pi settings without overwriting machine-local state. |
| `scripts/build-extensions.*`, `scripts/verify-install.mjs` | Repo build and verification logic. |
| `scripts/restart-lsp-daemon.sh` | npm postinstall runtime hygiene. |

The old non-deterministic standalone pi CLI npm install has been removed. The main remaining non-Nix operation is `npm ci`, which is deterministic through `package-lock.json` but still fetches npm artifacts unless cached.
