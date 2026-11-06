# Session identity and display names

Session-manager identifies each session by its session ID. IDs must be unique in the workspace manifest, including the coordinator ID. A live owner retains exclusive ownership of its session binding.

Names are optional, non-unique display labels. Active work sessions can start with the same explicit name, adopt that name, or rename to that name. A name does not select a session. Lookup, release, and restoration use session IDs.

An explicit name must contain non-whitespace text, fit within 128 UTF-8 bytes, and contain no control or format characters. These constraints also apply to names in the manifest.

`/session-status` and workspace restoration summaries show the full session ID beside a name. Tmux window labels retain explicit names, so multiple windows can have the same label. Unnamed windows use the existing `pi-<ID suffix>` label. Session-manager does not use window labels to select a binding.

## Binding locks

The lock file beside the tmux socket serializes bind/reclaim, rename, release,
and coordinator restore for that server, including cross-window session-ID
checks. Do not unlink it while that server is in use: waiters must share an inode.
Kernel locks survive pauses and are released on process exit; no stale lease can
expire underneath a live owner. A short-lived helper holds the lock until the
operation finishes or Pi closes its pipe (including after `kill -9`). Shutdown
drains in-flight tmux operations before unlocking. Missing `flock` or lock
contention past five seconds fails enrollment rather than mutating an unprotected
binding. See [prerequisites](prerequisites.md#tmux-session-ownership) for `flock`.
