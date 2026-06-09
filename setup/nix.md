# Nix support

`pi-env` stays a portable dotfiles-style repository: clone it, run `./setup.sh`, and let the repo manage pi package registration, extension builds, themes, skills, and safe managed settings.

Nix support is intentionally focused on the execution substrate. It provides the tools and optional Home Manager wiring needed to run setup and work on extensions, but it does not own mutable pi state.

The flake supports Linux and macOS on `x86_64` and `aarch64`:

- `x86_64-linux`
- `aarch64-linux`
- `x86_64-darwin`
- `aarch64-darwin`

## Fast path

On machines with Nix flakes enabled, the flattest setup path from a checkout is:

```bash
nix run .#setup
```

Equivalent explicit dev-shell form:

```bash
nix develop -c ./setup.sh
```

For a persistent user-profile install of the baseline toolchain:

```bash
nix profile install .#toolchain
./setup.sh
```

`nix profile install` installs tools only; `./setup.sh` still registers this pi package, runs npm install/build, and writes the user-local `pi` wrapper.

The flake setup app intentionally runs the checkout's `./setup.sh`; it does not try to run setup from an immutable Nix store copy. For remote first-run setup, clone first, then run `nix run .#setup` inside the checkout.

## Toolchain

The dev shell and installable `.#toolchain` package include:

- `git`
- Node.js 22 / `npm`
- `neovim`
- `tmux`
- `gh`
- `ripgrep`

JavaScript dependencies remain pinned by `package-lock.json`; `setup.sh` still performs npm installs. This avoids turning extension iteration into a Nix packaging workflow.

## Validation

Use layered validation depending on what changed:

```bash
# Validate the Nix flake outputs on a machine with Nix installed.
# This includes setup shell tests and JSON sanity checks.
nix flake check

# Validate the Nix-backed setup path from a checkout.
nix run .#setup

# Validate setup shell helpers without Nix.
npm run test:setup

# Validate pi-env install readiness after setup/npm install.
nix run .#verify-install
# equivalent: npm run verify:install

# Full pre-merge gate for code changes, including setup shell tests.
npm run verify
```

This agent environment may not always have Nix installed, so PRs that touch `flake.nix` should be checked on a Nix-capable Linux or macOS host before merge.

## Optional Home Manager module

The flake also exposes a Home Manager module for hosts where you want pi-env's shell/config pieces declared through Nix while keeping the source config in this repo:

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
- set `PI_ENV_CONFIG_MANAGED_BY_NIX=1` so later `./setup.sh` runs skip duplicate PATH/tmux/Ghostty writes
- enable Home Manager tmux and source `setup/tmux.conf`
- install Ghostty config/themes from `ghostty/` when `ghostty.enable = true`

Use the module for NixOS/nix-darwin/Home Manager hosts. Use `./setup.sh` directly on non-Nix hosts, devcontainers, one-off VMs, or anywhere you want the portable imperative setup path.

## Setup script retirement plan

Nix does not eliminate every setup script. The current scripts have different lifetimes:

| Script | Keep? | Why |
| --- | --- | --- |
| `setup.sh`, `setup/main.sh` | Keep | Portable non-Nix entrypoint and the command invoked by `nix run .#setup`. |
| `setup/context.sh`, `setup/lib.sh` | Keep | Shared setup plumbing for both direct and Nix-backed setup. |
| `setup/install.sh` | Keep | Runs npm install/build and installs the user-local pi CLI wrapper; this remains intentionally outside Nix packaging. |
| `setup/configure.sh` | Keep for now | Owns pi package registration, managed settings, prompts, repo hooks, and portable symlink setup. Parts can become optional when Home Manager owns tmux/Ghostty on a host. |
| `setup/environment.sh` | Keep for now | Still useful for non-Nix prerequisites and context detection; under Nix it becomes mostly confirmation/reporting. |
| `setup/apply-managed-settings.mjs` | Keep | Safely merges managed pi settings without overwriting machine-local state. |
| `scripts/build-extensions.*`, `scripts/verify-install.mjs` | Keep | Repo build/verification logic, independent of whether tools come from Nix. |
| `scripts/restart-lsp-daemon.sh` | Keep | npm postinstall runtime hygiene. |

What now shrinks under Nix/Home Manager:

- PATH profile edits are skipped when `PI_ENV_CONFIG_MANAGED_BY_NIX=1` or `PI_ENV_SKIP_PATH_PROFILE=1`.
- tmux symlinking is skipped when `PI_ENV_CONFIG_MANAGED_BY_NIX=1` or `PI_ENV_SKIP_TMUX=1`.
- Ghostty symlinking is skipped when `PI_ENV_CONFIG_MANAGED_BY_NIX=1` or `PI_ENV_SKIP_GHOSTTY=1`.

What can eventually shrink further:

- prerequisite messaging can become simpler for users who always enter through `nix run` or `nix develop`.
- terminal config setup can be split into a legacy compatibility path once the Home Manager module is proven on the hosts that use it.

I would not delete setup modules yet. First, use the flake app and Home Manager module on at least one Linux host and one macOS/Darwin host. After that, the terminal/profile portions of `setup/configure.sh` and `setup/install.sh` can be treated as compatibility paths rather than the primary Nix-host path.

## Boundary

For personal NixOS or nix-darwin hosts, bake only durable host-level tooling into Nix:

- `git`, Node.js 22, `npm`
- `neovim`, `tmux`, `gh`, `ripgrep`
- GUI terminal and fonts when appropriate, e.g. Ghostty and JetBrains Mono
- shell basics such as locale, `TERM`, and `~/.local/bin` on `PATH`

Keep these out of Nix:

- `~/.pi/agent/auth.json`
- pi sessions and machine-local settings
- provider/model defaults that vary by host
- `node_modules`, extension build output, and npm cache state
- secrets and private keys

This split makes Nix rebuilds reproducible without making `pi-env` less useful on macOS, devcontainers, one-off VMs, or other non-Nix environments.
