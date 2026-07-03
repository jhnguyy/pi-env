# pi-env

Personal [pi](https://github.com/badlogic/pi-mono) environment — extensions, skills, themes, and agent context as a dotfiles repo. Shared as a reference; setups are inherently personalized.

## Getting started

Prefer the Nix flake for a reproducible toolchain. Plain `./setup.sh` now chooses the best available path:

- **Local Nix**: setup tries `nix run .#setup` and falls back to portable setup if the current user cannot realize store paths.
- **Externally Nix-managed**: when `PI_ENV_CONFIG_MANAGED_BY_NIX=1` is already present, setup consumes provisioned tools and does not invoke `nix run`.
- **No Nix**: setup uses the current `PATH` tools.

| Environment | Command |
| --- | --- |
| Fresh machine with local Nix + flakes | `nix run github:jhnguyy/pi-env#bootstrap -- ~/pi-env` |
| Existing checkout | `./setup.sh` |
| Force local Nix, no fallback | `./setup.sh --use-nix` |
| Force provisioned Nix/tool ownership | `./setup.sh --nix-managed` |
| Force portable PATH tools | `./setup.sh --portable` |

`--use-nix` means “invoke local Nix now.” Use it only when failure is preferable to fallback. `--nix-managed` means “Nix already provided the toolchain/config ownership boundary.” It does not call `nix run`; it uses the existing `nub`, `node`, and `git` tools.

Portable fallback setup is still supported for hosts without Nix, but it intentionally uses whatever tools are already on `PATH`. See [`setup/nix.md`](setup/nix.md) for Nix details and [`setup/prerequisites.md`](setup/prerequisites.md) for the mode split.

Setup is safe to re-run after moving between dev environments. It installs repo dependencies, rebuilds extension artifacts, registers this checkout as a pi package, and reapplies the safe subset in `setup/managed-settings.json` without overwriting machine-local settings such as auth, model choices, or a customized theme.

## Terminal configs

In portable mode, `setup.sh` links `setup/tmux.conf` from `~/.tmux.conf` because tmux is useful on hosts, VMs, and devcontainers. In Nix-managed mode, the Home Manager module owns tmux config and setup skips this write.

Ghostty is only useful where a GUI terminal runs. Portable setup detects devcontainers/container-like environments and skips Ghostty linking there by default; GUI hosts and VMs get `ghostty/config` and `ghostty/themes/*` linked into `~/.config/ghostty/`. Nix-managed hosts can let the Home Manager module own these files. Set `PI_ENV_LINK_GHOSTTY=1 ./setup.sh` to force Ghostty linking in an unusual portable environment.

Ghostty uses JetBrains Mono at 18pt and auto-switches between pi-env Gruvbox dark/light palettes. Put machine-only Ghostty overrides in `~/.config/ghostty/config.local`; the repo config imports it if present.

Other Ghostty settings worth tuning per machine: window padding, cell-height adjustment, opacity/blur, cursor style, keybindings, and whether copy-on-select is desirable on shared machines.

## Pi CLI install

`setup.sh` runs `nub install --frozen-lockfile`, verifies the locked `@earendil-works/pi-coding-agent` package in this checkout, and writes a user-local `pi` wrapper that pins the Node executable selected during setup. That keeps later shell startup changes such as `nvm use` from silently changing the pi runtime. In local-Nix setup the flake app exports its Node path; in externally Nix-managed or portable setup, setup asks Nub for the project Node unless `PI_ENV_NODE_BIN` is set.

## Theme snippets

Slack custom theme strings:

- Gruvbox Dark: `#282828,#3c3836,#fe8019,#282828,#504945,#ebdbb2,#b8bb26,#fb4934,#1d2021,#ebdbb2`
- Gruvbox Light: `#fbf1c7,#ebdbb2,#af3a03,#fbf1c7,#d5c4a1,#3c3836,#79740e,#9d0006,#f9f5d7,#3c3836`

## Further reading

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — branch conventions, building extensions, worktree workflow
- **[setup/nix.md](setup/nix.md)** — optional Nix dev shell and NixOS/Home Manager guidance
- **[setup/improvements.md](setup/improvements.md)** — setup cleanup backlog and review pressure
- **[pi docs](https://github.com/badlogic/pi-mono)** — upstream reference for the extensions API, skills spec, and settings
