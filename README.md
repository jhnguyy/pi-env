# pi-env

Personal [pi](https://github.com/badlogic/pi-mono) environment — extensions, skills, themes, and agent context as a dotfiles repo. Shared as a reference; setups are inherently personalized.

## Setup

Prerequisites: `git`, Node.js ≥ 22.19, and npm ≥ 10. The repo includes `.node-version` / `.nvmrc` pinned to `22.19.0`. See [`setup/prerequisites.md`](setup/prerequisites.md) for macOS/Linux package hints and recommended daily-driver tools.

```bash
git clone <your-fork> ~/pi-env
cd ~/pi-env
./setup.sh
# Open a new shell (or source your shell profile) before running `pi`.
```

`setup.sh` is a thin entrypoint into `setup/main.sh`; supporting setup modules and assets live under `setup/`. `setup/context.sh` receives the setup directory from the entrypoint and derives repo paths, target paths, and environment decisions once for the other modules. Setup orchestration is grouped by domain: environment checks, runtime installs, Pi config, terminal tools, and repo tools.

Setup is safe to re-run after moving between dev environments. It performs clean installs with npm optional dependencies enabled so native packages such as `esbuild` are selected for the current platform.

Setup does not run the full Vitest suite by default. Routine install and post-merge setup should be cheap and operational: install dependencies, rebuild extensions, and leave the repo ready to use. Run `npm run verify:install` for a cheap setup/readiness check, and run `npm run verify` before merging code changes.

`setup/settings.template.json` bootstraps new machines only. Existing machine-specific settings are preserved, but `setup/managed-settings.json` is reapplied on every run for small cross-machine defaults that should stay consistent. Today that managed subset keeps pi's agent-level retry enabled while limiting provider request attempts to 20 seconds with one provider-level retry, so Anthropic stalls fail quickly before pi's visible agent-level retry takes over.

## Terminal configs

`setup.sh` always links `setup/tmux.conf` from `~/.tmux.conf` because tmux is useful on hosts, VMs, and devcontainers.

Ghostty is only useful where a GUI terminal runs. Setup detects devcontainers/container-like environments and skips Ghostty linking there by default; GUI hosts and VMs get `ghostty/config` and `ghostty/themes/*` linked into `~/.config/ghostty/`. Set `PI_ENV_LINK_GHOSTTY=1 ./setup.sh` to force Ghostty linking in an unusual environment.

Ghostty uses JetBrains Mono at 18pt and auto-switches between pi-env Gruvbox dark/light palettes. Put machine-only Ghostty overrides in `~/.config/ghostty/config.local`; the repo config imports it if present.

Other Ghostty settings worth tuning per machine: window padding, cell-height adjustment, opacity/blur, cursor style, keybindings, shell integration, and whether copy-on-select is desirable on shared machines.

## Pi CLI install

`setup.sh` installs `@earendil-works/pi-coding-agent` with npm into `~/.local/share/pi-env/pi-cli` and writes `~/.local/bin/pi`. If `~/.local/bin` is not already on `PATH`, setup idempotently adds it to existing `~/.zshrc`, `~/.bashrc`, and/or `~/.profile` files, falling back to creating `~/.profile` when no shell profile exists. The wrapper runs Pi's Node entrypoint.

## Test and verification commands

- `npm test` / `npm run test:unit` — default unit test suite; E2E tests are excluded for lower noise.
- `npm run test:e2e` — explicit E2E/integration suite gated by `E2E=1`.
- `npm run verify:install` — cheap setup readiness check that rebuilds and verifies extension bundles/manifests.
- `npm run verify` — pre-merge gate: typecheck, build, and unit tests.

## Themes

This package registers the `themes/` directory with pi and the theme scheduler applies the matching Gruvbox theme automatically at startup. By default it uses `gruvbox-light` during the configured daytime window and `gruvbox-dark` otherwise.

To customize or disable automatic switching, edit the theme scheduler in `settings.json`:

```json
{
  "themeScheduler": {
    "enabled": true,
    "lightTheme": "gruvbox-light",
    "darkTheme": "gruvbox-dark",
    "lightStart": "10:00",
    "lightEnd": "16:00"
  }
}
```

`lightStart` is inclusive and `lightEnd` is exclusive, so the defaults use light mode from 10:00 through 15:59 and dark mode otherwise. The scheduler sets one timer for the next transition rather than polling. Scheduled switches also persist the global `theme` setting; pi's settings manager serializes concurrent writes so multiple running pi processes cannot corrupt `settings.json`. Set `"enabled": false` if you want pi's own theme selection to take over.

Slack custom theme strings:

- Gruvbox Dark: `#282828,#3c3836,#fe8019,#282828,#504945,#ebdbb2,#b8bb26,#fb4934,#1d2021,#ebdbb2`
- Gruvbox Light: `#fbf1c7,#ebdbb2,#af3a03,#fbf1c7,#d5c4a1,#3c3836,#79740e,#9d0006,#f9f5d7,#3c3836`

## Further reading

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — branch conventions, building extensions, worktree workflow
- **[pi docs](https://github.com/badlogic/pi-mono)** — upstream reference for the extensions API, skills spec, and settings
