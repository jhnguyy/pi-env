# pi-env prerequisites

Nix-backed setups can supply the workbench through the [runtime integration](setup.md#runtime-integration). Without Nix, portable setup requires Git and Nub; Nub selects the Node runtime from `package.json#engines.node`.

Setup performs one frozen dependency installation, followed by [hydration](../scripts/hydrate.mjs). It does not delete dependencies or retry a failed installation.

Local Nix needs flakes and a usable store. Externally managed setup consumes supplied tools without invoking Nix. Neither path changes system packages or remote-builder configuration through portable setup.

Personal defaults and explicit reset behavior are described in [setup](setup.md). Resource enablement belongs to Pi's stock package manager.

## Recommended tools

Setup [reports](../setup/environment.sh) missing recommended tools, including Ghostty on GUI hosts, but does not install them. The [Ghostty config](../ghostty/config) selects its font. See [themes](themes.md#terminals) for terminal installation.

## tmux session ownership

Session-manager binding mutations require `flock` on `PATH` (util-linux on Linux,
[discoteq/flock](https://github.com/discoteq/flock) on macOS). The Nix toolchain
supplies the cross-platform implementation; the container supplies util-linux.
Portable setups must supply it themselves. See
[binding locks](session-manager.md#binding-locks) for lock behavior.
