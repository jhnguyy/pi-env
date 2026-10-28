# Agent status in tmux

The `general` extension adds a persistent status indicator to tmux window tabs in interactive Pi sessions. The completion bell remains unchanged. Done means the run settled, not that the broader task is complete.

## Enable the display

Load the updated [tmux template](../setup/templates/tmux.conf), then restart Pi or use `/reload`. Setup normally sources this template from `~/.tmux.conf`; externally managed environments must arrange that integration themselves. With `pi-env.tmux.enable`, the [Home Manager module](nix.md#home-manager) sources the template from the locked pi-env flake input, not the checkout. Update that input and activate the new generation, then run `tmux source-file ~/.config/tmux/tmux.conf`. To try the template in the current server:

```bash
tmux source-file /path/to/pi-env/setup/templates/tmux.conf
```

Replace `/path/to/pi-env` with the checkout path. This command applies the whole template, including its theme and key settings. For custom tab formats, insert `#{?@pi_agent_status,#{E:@pi_agent_status} ,}` before the window label in both `window-status-format` and `window-status-current-format`. The indicator ends with `#[default]`, so put tab colors in `window-status-style` and `window-status-current-style` rather than inline `#[...]` styles before the indicator.

Status metadata does not change session names. Only the indicator receives status styling; window labels keep the tab's text color and background, including the active-tab highlight.

## Interpret the indicator

| Indicator       | Meaning                             |
| --------------- | ----------------------------------- |
| Braille spinner | Running, including compaction       |
| `✓`             | Settled successfully                |
| `✗`             | Final response or compaction failed |
| `○`             | Idle or cancelled                   |

A failed tool call does not determine the final status. Retries stay running until settlement. Blocking dialogs keep the underlying state because this display has no separate blocked indicator.

Background state changes use bold styling. Viewing the window in any attached client marks its current state seen and returns the indicator to normal weight. Animation and theme changes do not make a seen state unseen again. Visibility and theme polling waits one second between updates while resting, or 250 ms while running. A visit shorter than the polling interval can be missed.

When several Pi panes share a window, running takes precedence over error, done, and idle. Equal states use the lowest pane ID, including that pane's theme and attention state. The tab is a summary, not a count of unseen panes.

When tabs overflow the bar, tmux shows `<` and `>` arrows. Each arrow takes the color of the highest-priority agent among all windows on that side of the current window, including windows that remain visible. Custom status formats can reuse the template's `@pi_agent_left_style` and `@pi_agent_right_style`, which read each window's `@pi_agent_rank`.

## Compatibility and recovery

Colors follow the public active-theme API. Indexed colors remain terminal palette indices; RGB and OKLCH colors use truecolor. Bold weight marks attention without guessing indexed RGB colors. The indicator suits the bar when Pi and the [tmux template](themes.md#terminals) resolve the same light or dark theme; a fixed Pi theme can mismatch the bar. Custom working indicators from other extensions cannot be read through Pi's public API; the tab uses the default braille frames at a slower cadence.

Orderly quit, reload, and session replacement remove the session's metadata. Another running status adapter prunes metadata whose owner PID has exited. If the last Pi process is forcibly killed, its indicator can remain until another Pi adapter polls or the window closes. PID reuse can delay that pruning. Missing or unresponsive tmux never fails the agent run.

## Design constraints

Status reporting stays separate from the [session-manager host](../.pi/extensions/session-manager/host.ts): best-effort display updates should not acquire the authority or socket-wide locks used to bind and restore sessions. Pi exposes neither a public subscription to its consolidated program status nor a theme-change subscription, so lifecycle observation and theme polling remain necessary.
