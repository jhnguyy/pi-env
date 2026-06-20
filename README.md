# pi-env

Personal [pi](https://github.com/badlogic/pi-mono) environment — extensions, skills, themes, and agent context as a dotfiles repo. Shared as a reference; setups are inherently personalized.

## Setup

Nix path prerequisite: Nix with flakes enabled. Portable fallback prerequisites: `git`, Node.js ≥ 22.19, and Bun ≥ 1.3. The repo includes `.node-version` / `.nvmrc` pinned to `22.19.0`; Node remains the runtime for pi while Bun owns dependency install and script execution. See [`setup/prerequisites.md`](setup/prerequisites.md) for macOS/Linux package hints and recommended daily-driver tools.

```bash
git clone <your-fork> ~/pi-env
cd ~/pi-env
./setup.sh
# Open a new shell (or source your shell profile) before running `pi`.
```

If the host uses Nix with flakes enabled, one command can clone and set up the repo:

```bash
nix run github:jhnguyy/pi-env#bootstrap -- ~/pi-env
```

From an existing checkout, run setup with the repo toolchain:

```bash
nix run .#setup
```

For a persistent user-profile tool install, run `nix profile install .#toolchain` first, then `./setup.sh --nix-managed`. See [`setup/nix.md`](setup/nix.md) for Linux/macOS support, validation commands, the optional Home Manager module, and the intended Nix split: Nix owns host tools; `pi-env` owns portable pi configuration and mutable setup.

`setup.sh` is a thin entrypoint into `setup/main.sh`; supporting setup modules and assets live under `setup/`. `setup/context.sh` receives the setup directory from the entrypoint and derives repo paths, target paths, and environment decisions once for the other modules. Setup orchestration is grouped by domain: environment checks, runtime installs, Pi config, terminal tools, and repo tools.

Setup is safe to re-run after moving between dev environments. It performs clean installs with Bun so native packages such as `esbuild` are selected for the current platform.

Setup does not run the full Vitest suite by default. Routine install and post-merge setup should be cheap and operational: install dependencies, rebuild extensions, and leave the repo ready to use. Run `bun run verify:install` for a cheap setup/readiness check, and run `bun run verify` before merging code changes.

`setup/settings.template.json` bootstraps new machines only. Existing machine-specific settings are preserved, but `setup/managed-settings.json` is reapplied on every run for small cross-machine defaults that should stay consistent. Today that managed subset keeps pi's agent-level retry enabled while limiting provider request attempts to 20 seconds with one provider-level retry, so Anthropic stalls fail quickly before pi's visible agent-level retry takes over.

## Terminal configs

In portable mode, `setup.sh` links `setup/tmux.conf` from `~/.tmux.conf` because tmux is useful on hosts, VMs, and devcontainers. In Nix-managed mode, the Home Manager module owns tmux config and setup skips this write.

Ghostty is only useful where a GUI terminal runs. Portable setup detects devcontainers/container-like environments and skips Ghostty linking there by default; GUI hosts and VMs get `ghostty/config` and `ghostty/themes/*` linked into `~/.config/ghostty/`. Nix-managed hosts can let the Home Manager module own these files. Set `PI_ENV_LINK_GHOSTTY=1 ./setup.sh` to force Ghostty linking in an unusual portable environment.

Ghostty uses JetBrains Mono at 18pt and auto-switches between pi-env Gruvbox dark/light palettes. Put machine-only Ghostty overrides in `~/.config/ghostty/config.local`; the repo config imports it if present.

Other Ghostty settings worth tuning per machine: window padding, cell-height adjustment, opacity/blur, cursor style, keybindings, shell integration, and whether copy-on-select is desirable on shared machines.

## Pi CLI install

`setup.sh` runs deterministic `bun install --frozen-lockfile` from `bun.lock` and writes `~/.local/bin/pi`. The wrapper points at the locked `@earendil-works/pi-coding-agent` package in this checkout's `node_modules` and executes it with Node. If `~/.local/bin` is not already on `PATH`, portable setup idempotently adds it to existing `~/.zshrc`, `~/.bashrc`, and/or `~/.profile` files, falling back to creating `~/.profile` when no shell profile exists. Nix-managed setup skips profile edits because the flake/Home Manager path owns PATH.

## Test and verification commands

- `bun run test` / `bun run test:unit` — default unit test suite; E2E tests are excluded for lower noise.
- `bun run test:e2e` — explicit E2E/integration suite gated by `E2E=1`.
- `bun run verify:install` — cheap setup readiness check that rebuilds and verifies extension bundles/manifests.
- `bun run verify` — pre-merge gate: typecheck, build, and unit tests.

## Themes

This package registers the `themes/` directory with pi and uses pi's automatic light/dark theme setting. The default setup template sets:

```json
{
  "theme": "gruvbox-light/gruvbox-dark"
}
```

The value before `/` is used when the terminal reports a light color scheme, and the value after `/` is used for dark mode. Pi also follows terminal color-scheme change notifications when supported. To opt out, set `theme` to a single theme name such as `"gruvbox-dark"`, `"gruvbox-light"`, `"dark"`, or `"light"`.

Slack custom theme strings:

- Gruvbox Dark: `#282828,#3c3836,#fe8019,#282828,#504945,#ebdbb2,#b8bb26,#fb4934,#1d2021,#ebdbb2`
- Gruvbox Light: `#fbf1c7,#ebdbb2,#af3a03,#fbf1c7,#d5c4a1,#3c3836,#79740e,#9d0006,#f9f5d7,#3c3836`

## Further reading

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — branch conventions, building extensions, worktree workflow
- **[setup/nix.md](setup/nix.md)** — optional Nix dev shell and NixOS/Home Manager guidance
- **[pi docs](https://github.com/badlogic/pi-mono)** — upstream reference for the extensions API, skills spec, and settings
