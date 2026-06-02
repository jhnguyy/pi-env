# pi-env prerequisites

`setup.sh` checks required commands and prints recommended tools for the current OS and runtime context. It does not install system packages automatically.

Context rules:

- **Devcontainer/container**: install/link CLI and tmux-oriented config; skip GUI-terminal setup such as Ghostty by default.
- **GUI host or VM**: install/link CLI, tmux config, and Ghostty config/themes.
- Set `PI_ENV_LINK_GHOSTTY=1` to force Ghostty linking when detection is wrong.

## Required

| Tool | macOS | Linux | Why |
| --- | --- | --- | --- |
| git | Xcode Command Line Tools or `brew install git` | `apt install git`, `dnf install git`, or equivalent | clone/update this repo |
| node >= 22.19 | `brew install node@22`, `fnm`, `mise`, or `nvm` | NodeSource, distro package if current enough, `fnm`, `mise`, or `nvm` | pi and extension tooling |
| npm >= 10 | included with Node 22 | included with Node 22 | dependency install |

## Recommended daily-driver tools

| Tool | macOS | Linux | Why |
| --- | --- | --- | --- |
| Ghostty | `brew install --cask ghostty` | distro package/AppImage from Ghostty project | GUI terminal config on hosts/VMs; skipped in devcontainers by default |
| JetBrains Mono | `brew install --cask font-jetbrains-mono` | distro font package or JetBrains download | terminal font used by Ghostty config |
| tmux | `brew install tmux` | `apt install tmux`, `dnf install tmux`, or equivalent | terminal multiplexing; useful in devcontainers and VMs |
| gh | `brew install gh` | GitHub CLI package for your distro | PR/release workflow |
| ripgrep | `brew install ripgrep` | `apt install ripgrep`, `dnf install ripgrep`, or equivalent | fast text searches |
