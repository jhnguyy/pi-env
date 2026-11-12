# Session manager

`session-manager` names the current tmux window for an interactive Pi session. It uses the native session name when present; otherwise it uses `pi-` followed by the session ID's last six characters. UUIDv7 IDs share a timestamp prefix, so the random tail distinguishes sessions started close together. The fallback is only a window label: it does not set a native session name.

Native `/name` changes, including clearing the name, update the window. Names remain literal rather than evaluating tmux formats; tmux applies its usual visible escaping to backslashes and control characters.

## Window ownership

Naming starts only in TUI mode with `TMUX` and a valid `TMUX_PANE`. Native child sessions do not register naming handlers. Other modes and sessions outside tmux do nothing. General status reporting remains independent of naming.

An unowned window with `automatic-rename off` is treated as manually named and left alone. Otherwise the extension uses two window-local tmux options, `@pi_naming_owner` and `@pi_naming_label`, to guard changes:

- The first Pi pane to claim a window owns its label. A Pi session in another split pane cannot steal it; ownership does not automatically transfer when the first exits.
- A new runtime in the same pane can replace its predecessor's token. The old runtime cannot rename or release its successor's window.
- A manual tmux rename that differs from the last applied label prevents subsequent Pi renames. Shutdown clears its own tags but leaves that manual name and its automatic-renaming setting alone.
- Normal shutdown removes its own tags and re-enables automatic naming only when the window still has its last applied label. Session replacement and reload follow Pi's native shutdown/start lifecycle.

A crash can leave tags behind. A later runtime in the same pane can reclaim them if the label has not changed. There is no cross-pane recovery or registry. To opt out, manually rename the window; to reuse a stranded window from another pane, clear both `@pi_naming_owner` and `@pi_naming_label` with tmux and enable `automatic-rename` before starting Pi. Changing a manual name back to the exact last-applied label is indistinguishable from retaining the extension's label.

The extension creates no manifests, session catalog, sockets, sidecars, custom commands, or editor hooks. It does not enroll sessions, coordinate workspaces, mark completion, or restore runtimes. Naming failures produce a warning without blocking native session behavior.

## Updating from coordinator-based session management

Rerun setup after updating the registered checkout to replace the old launcher,
then restart Pi or use `/reload` to load the new extension. Nix-owned launchers
require activation through the consuming host configuration instead.
`pi --start` and the `/session-*` commands are retired; use native session resume.
Existing manifests, transcripts, handoffs, and retrospectives are left untouched.
Windows with automatic naming disabled remain unchanged, including old labels.

## Verification

The focused integration suite uses real tmux on temporary private servers, an empty tmux configuration, and isolated agent directories. It invokes native lifecycle handlers with a small API adapter; it does not qualify loading a built bundle in Pi's interactive TUI.

```bash
nub run test:integration extensions/session-manager/__tests__/naming.integration.test.ts
```
