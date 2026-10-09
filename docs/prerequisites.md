# pi-env prerequisites

[`setup.sh`](../setup.sh) is the executable authority for prerequisite checks, setup modes, Node/Nub selection, and fallback behavior.

Nub is the canonical JavaScript toolchain boundary. Setup runs one frozen dependency installation and reports its result. It does not delete `node_modules` or retry after an installation failure.

Local-Nix setup requires Nix with flakes. Externally managed setup consumes the provisioned toolchain. Portable setup checks host commands but does not install system packages.

Setup choices and ownership boundaries are documented in [`nix.md`](nix.md). Source-owned configuration and scripts live in [`package.json`](../package.json), [`nub.jsonc`](../nub.jsonc), [`flake.nix`](../flake.nix), and [`setup/`](../setup).

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
