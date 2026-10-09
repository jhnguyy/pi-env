# pi-env prerequisites

Nix supplies the workbench through [the upstream packaging boundary](nix.md). Without Nix, portable setup requires Git and Nub; Nub selects the Node runtime from `package.json#engines.node`.

Setup performs one frozen dependency installation. The shared hydration operation patches the Effect language service, builds extensions, and restarts the LSP daemon after artifacts are ready. Setup does not delete dependencies or retry a failed installation.

Local Nix needs flakes and a usable store. Externally managed setup consumes supplied tools without invoking Nix. Neither path changes system packages or remote-builder configuration through portable setup.

Personal defaults and explicit reset behavior are described in [setup](setup.md). Resource enablement belongs to Pi's stock package manager.

## tmux session ownership

Session-manager binding mutations require `flock` on `PATH` (util-linux on Linux,
[discoteq/flock](https://github.com/discoteq/flock) on macOS). The Nix toolchain
supplies the cross-platform implementation; the container supplies util-linux.
Portable setups must supply it themselves. Missing `flock` or lock contention
past five seconds fails enrollment rather than mutating an unprotected binding.

The lock file beside the tmux socket serializes bind/reclaim, rename, release,
and coordinator restore for that server, including cross-window session-ID
checks. Do not unlink it while that server is in use: waiters must share an inode.
Kernel locks survive pauses and are released on process exit; no stale lease can
expire underneath a live owner. A short-lived helper holds the lock until the
operation finishes or Pi closes its pipe (including after `kill -9`). Shutdown
drains in-flight tmux operations before unlocking. Names remain display labels;
session IDs identify sessions, and a live PID exclusively owns each binding.
