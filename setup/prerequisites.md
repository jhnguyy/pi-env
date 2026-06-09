# pi-env prerequisites

Nix path prerequisite: Nix with flakes enabled. Then run `nix run github:jhnguyy/pi-env#bootstrap -- ~/pi-env` on a fresh machine, or `nix run .#setup` from an existing checkout.

Portable fallback prerequisite: `setup.sh` checks required commands and prints recommended tools for the current OS and runtime context. It does not install system packages automatically.

See [`nix.md`](nix.md) for Linux/macOS support, validation commands, the optional Home Manager module, setup modes, and what stays managed by `pi-env`.

Context rules:

- **Devcontainer/container**: install/link CLI and tmux-oriented config; skip GUI-terminal setup such as Ghostty by default.
- **GUI host or VM**: install/link CLI, tmux config, and Ghostty config/themes.
- Set `PI_ENV_LINK_GHOSTTY=1` to force Ghostty linking when detection is wrong.

## Required for portable fallback

| Tool | macOS | Linux | Why |
| --- | --- | --- | --- |
| git | Xcode Command Line Tools or `brew install git` | `apt install git`, `dnf install git`, or equivalent | clone/update this repo |
| node >= 22.19 | `brew install node@22`, `fnm`, `mise`, `nvm`, or `nix develop` | Nix `nodejs_22`, NodeSource, distro package if current enough, `fnm`, `mise`, or `nvm` | pi and extension tooling |
| npm >= 10 | included with Node 22 | included with Node 22 / Nix `nodejs_22` | dependency install |

## Recommended daily-driver tools

| Tool | macOS | Linux | Why |
| --- | --- | --- | --- |
| Ghostty | `brew install --cask ghostty` | distro package/AppImage from Ghostty project | GUI terminal config on hosts/VMs; skipped in devcontainers by default |
| JetBrains Mono | `brew install --cask font-jetbrains-mono` | distro font package or JetBrains download | terminal font used by Ghostty config |
| tmux | `brew install tmux` | `apt install tmux`, `dnf install tmux`, or equivalent | terminal multiplexing; useful in devcontainers and VMs |
| neovim | `brew install neovim` | `apt install neovim`, `dnf install neovim`, Nix `neovim`, or equivalent | terminal editor available everywhere pi-env runs |
| gh | `brew install gh` | GitHub CLI package for your distro | PR/release workflow |
| ripgrep | `brew install ripgrep` | `apt install ripgrep`, `dnf install ripgrep`, Nix `ripgrep`, or equivalent | fast text searches |

The repo flake's dev shell and installable `.#toolchain` package include `git`, Node.js 22, `npm`, `neovim`, `tmux`, `gh`, and `ripgrep`. GUI tools such as Ghostty and fonts are intentionally opt-in through host package management or the Home Manager module because they vary more by machine and OS.
