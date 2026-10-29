# Agent status in tmux

The `general` extension adds a persistent status indicator to tmux window tabs in interactive Pi sessions. The completion bell remains unchanged. Done means the run settled, not that the broader task is complete.

## Enable the display

Load the updated [tmux template](../setup/templates/tmux.conf), then restart Pi or use `/reload`. Setup normally sources this template from `~/.tmux.conf`; externally managed environments must arrange that integration themselves. With `pi-env.tmux.enable`, the [Home Manager module](nix.md#home-manager) sources the template from the locked pi-env flake input, not the checkout. Update that input and activate the new generation, then run `tmux source-file ~/.config/tmux/tmux.conf`. To try the template in the current server:

```bash
tmux source-file /path/to/pi-env/setup/templates/tmux.conf
```

Replace `/path/to/pi-env` with the checkout path. This command applies the whole template, including its theme and key settings. For custom tab formats, insert the indicator before the window label and then restore the tab style, as the template's `window-status-format` and `window-status-current-format` do.

Status metadata does not change session names. Only the indicator receives status styling; window labels keep the tab's text color and background, including the active-tab highlight.

## Interpret the indicator

| Indicator       | Meaning                             |
| --------------- | ----------------------------------- |
| Braille spinner | Running, including compaction       |
| `✓`             | Settled successfully                |
| `✗`             | Final response or compaction failed |
| `○`             | Idle or cancelled                   |

A failed tool call does not determine the final status. Retries stay running until settlement. Blocking dialogs keep the underlying state because this display has no separate blocked indicator.

Background state changes use bold styling. Viewing the window in any attached client marks its current state seen and returns the indicator to normal weight. Animation and theme changes do not make a seen state unseen again. Visibility and theme polling waits one second between updates. A visit shorter than the polling interval can be missed.

Running spinners advance at Pi's default 80 ms loader cadence, following the clock rather than Pi's own loader phase, so every running tab shows the same frame. One Pi process per tmux server leads a shared ticker: it keeps a single `no-output`, read-only control-mode client attached and writes the current frame to the global `@pi_agent_spinner` option, which running indicators reference. That client counts toward the session's attached clients but never marks a window seen. The leader releases the ticker when no window is running or its sessions close, and a running session in another Pi process takes over. If the ticker cannot start, running tabs show a static first frame.

When several Pi panes share a window, running takes precedence over error, done, and idle. Equal states use the lowest pane ID, including that pane's theme and attention state. The tab is a summary, not a count of unseen panes.

When tabs overflow the bar, tmux shows `<` and `>` arrows. Each arrow takes the color of the highest-priority agent among all windows on that side of the current window, including windows that remain visible. Custom status formats can reuse the template's `@pi_agent_left_style` and `@pi_agent_right_style`, which read each window's `@pi_agent_rank`.

## Compatibility and recovery

The [tmux template](../setup/templates/tmux.conf) requires tmux 3.8 or newer for its theme colors and status format. The [Nix toolchain](../nix/toolchain.nix) rejects an older locked tmux, and the [container image](../Dockerfile) builds the pinned release with [`scripts/install-tmux.sh`](../scripts/install-tmux.sh). Portable hosts must provide tmux 3.8 themselves.

Colors follow the public active-theme API. Indexed colors remain terminal palette indices; RGB and OKLCH colors use truecolor. Bold weight marks attention without guessing indexed RGB colors. The indicator suits the bar when Pi and the [tmux template](themes.md#terminals) resolve the same light or dark theme; a fixed Pi theme can mismatch the bar. Custom working indicators from other extensions cannot be read through Pi's public API; the tab uses the default braille frames.

Orderly quit, reload, and session replacement remove the session's metadata. Another running status adapter prunes metadata whose owner PID has exited. If the last Pi process is forcibly killed, its indicator can remain until another Pi adapter polls or the window closes. PID reuse can delay that pruning. Missing or unresponsive tmux never fails the agent run.

## Design constraints

Status reporting stays separate from the [session-manager host](../.pi/extensions/session-manager/host.ts): best-effort display updates should not acquire the authority or socket-wide locks used to bind and restore sessions. Pi exposes neither a public subscription to its consolidated program status nor a theme-change subscription, so lifecycle observation and theme polling remain necessary.
