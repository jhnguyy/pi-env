# pi-env prerequisites

Nix-backed setups can supply the workbench through the [runtime integration](setup.md#runtime-integration). Without Nix, portable setup requires Git and Nub; Nub selects the Node runtime from `package.json#engines.node`.

Setup performs one frozen dependency installation. The shared hydration operation patches the Effect language service, builds extensions, and restarts the LSP daemon after artifacts are ready. Setup does not delete dependencies or retry a failed installation.

Local Nix needs flakes and a usable store. Externally managed setup consumes supplied tools without invoking Nix. Neither path changes system packages or remote-builder configuration through portable setup.

Personal defaults and explicit reset behavior are described in [setup](setup.md). Resource enablement belongs to Pi's stock package manager.

## Recommended tools

Setup reports whether `tmux`, `gh`, and `rg` are on `PATH` but does not install them. On GUI hosts it also checks for Ghostty; the [Ghostty config](../ghostty/config) uses the JetBrains Mono font. See [themes](themes.md#terminals) for terminal installation.

## tmux session ownership

Session-manager binding mutations require `flock` on `PATH` (util-linux on Linux,
[discoteq/flock](https://github.com/discoteq/flock) on macOS). The Nix toolchain
supplies the cross-platform implementation; the container supplies util-linux.
Portable setups must supply it themselves. See
[binding locks](session-manager.md#binding-locks) for lock behavior.
