# pi-env prerequisites

Nix-backed setups can supply the workbench through the [runtime integration](setup.md#runtime-integration). Without Nix, portable setup requires Git and Nub; Nub selects the Node runtime from `package.json#engines.node`.

Setup performs one frozen dependency installation, followed by [hydration](../scripts/hydrate.mjs). It does not delete dependencies or retry a failed installation.

Local Nix needs flakes and a usable store. Externally managed setup consumes supplied tools without invoking Nix. Neither path changes system packages or remote-builder configuration through portable setup.

Personal defaults and explicit reset behavior are described in [setup](setup.md). Resource enablement belongs to Pi's stock package manager.

## Recommended tools

Setup [reports](../setup/environment.sh) missing recommended tools, including Ghostty on GUI hosts, but does not install them. The [Ghostty config](../ghostty/config) selects its font. See [themes](themes.md#terminals) for terminal installation.

## tmux window naming

Interactive Pi sessions inside tmux can label their windows through
[session-manager](session-manager.md). Naming does not require a coordinator or a
workspace manifest.

## Dev-tools daemon ownership

The dev-tools daemon requires `flock` on `PATH` for lifetime ownership of its socket
and PID artifacts. Nix supplies the cross-platform implementation; the container
supplies util-linux. Portable setups must supply `flock` themselves.

The daemon holds its lock until shutdown releases its listener, backends, and
artifacts. Clients never remove daemon artifacts, and install-time restart uses
the shutdown protocol rather than signaling a PID read from a file. Busy or
incomplete cleanup fails closed; it does not force a takeover.
