# Gruvbox themes

## Pi

Setup registers the [Pi themes](../themes/). Fresh setup and explicit reset select `gruvbox-light/gruvbox-dark`. Ordinary setup preserves personal choices.

Use `/settings` to choose a theme, or `system` to follow terminal colors. After a package update, use `/reload`. If themes are missing, check their availability with `pi config`.

## Terminals

[Terminal setup](../setup/terminal-config.mjs) installs Ghostty's light/dark palettes on GUI hosts and a tmux style that follows the background each client reports, treating an unknown background as dark. Set `PI_ENV_LINK_GHOSTTY=1` to install Ghostty files elsewhere.

Keep Ghostty overrides in `~/.config/ghostty/config.local`. Reload Ghostty after setup and run `ghostty +validate-config`.

For Home Manager, enable `pi-env.ghostty.enable` and switch generations instead of letting setup manage those files. Other terminal applications have no setup integration.

### Chrome roles

Chrome uses a tonal surface hierarchy, with container/text pairs rather than accent-colored ordinary text:

| Role                              | Dark      | Light     |
| --------------------------------- | --------- | --------- |
| Content (bg0), also text on focus | `#282828` | `#fbf1c7` |
| Bar/chrome (bg1)                  | `#3c3836` | `#ebdbb2` |
| Raised container (bg2)            | `#504945` | `#d5c4a1` |
| Primary text (fg1)                | `#ebdbb2` | `#3c3836` |
| Secondary/muted text (fg2)        | `#d5c4a1` | `#504945` |
| Focus container/border (orange)   | `#fe8019` | `#af3a03` |

The native tmux slots are role aliases, not terminal ANSI colors: `black` is bg1, `dark-grey` bg2, `white` fg1, `light-grey` fg2, `yellow` orange, and the otherwise unused `blue` is bg0 for on-focus text. The session label uses bg2/fg1; the current tab and copy selection use orange/bg0. Active agent glyphs inherit the current tab's foreground and background; inactive glyphs keep their semantic status colors on neutral bg1. Both restore the label style afterward. Active pane borders remain orange. Native detected or forced themes resolve the same roles without runtime synchronization.

Desktop chrome follows the same roles: Waybar uses bg1 behind bg2 module surfaces, neutral values and secondary workspace labels; focus/mode uses orange/bg0. Critical/urgent Waybar states use bg0 inset alert surfaces with readable neutral text, a red inset cue, and bold weight rather than red body text. Sway uses secondary inactive text and orange/bg0 focus; urgent titles use darkRed/fg0 in dark mode (4.82:1) or red/bg0 in light mode (7.60:1), with red borders in both.

Use [W3C's 4.5:1 normal-text target](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) and [3:1 nontext indicator target](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) when changing chrome. Primary and secondary text on bg2 reach at least 6.43:1 and 5.14:1 respectively; orange/bg0 reaches at least 5.40:1. Orange text on bg2 does not reach 4.5:1, so use the focus container pair instead. Surface steps are intentionally subtle (bg1/bg2 about 1.31:1 dark, 1.25:1 light), not standalone focus indicators. These are design targets, not a blanket accessibility claim or an audit of syntax/agent colors. Raw palettes, Ghostty ANSI/content themes, and Pi syntax themes remain independent and unchanged.

### Bash prompt

For an optional Bash prompt, manually source the [prompt fragment](../setup/templates/bash-prompt.sh) from your interactive shell configuration (replace the checkout path):

```bash
source /path/to/pi-env/setup/templates/bash-prompt.sh
```

This opt-in owns `PS1` and displays `[user@host:cwd]$ ` (root uses `#`), with no space before the marker. Bash inherits its palette from the terminal: native ANSI green (SGR 32) provides supplemental identity emphasis, the directory is bold terminal-default text, and brackets, colon, marker, and input explicitly reset to terminal-default foreground (SGR 39) and nonbold styling. With the Ghostty light/dark pair active, these are Gruvbox colors; the fragment does not parse Pi themes or remap colors. Contrast depends on the terminal palette: current Ghostty light green reaches 4.29:1, below the 4.5:1 normal-text target; dark passes that target. This is not a blanket accessibility claim. The fragment leaves hooks and `TERM` alone and does nothing in noninteractive shells or with unset/empty `TERM` or `TERM=dumb`. Setup does not install it automatically.

With Home Manager, enable `pi-env.shell.bashPrompt.enable = true` alongside `programs.bash.enable = true`. This option is off by default and independent of the PATH option `pi-env.shell.enable`; an explicit consumer `programs.bash.promptInit` takes precedence.

### Ghostty over SSH and tmux

The Ghostty config enables native SSH integration: it installs remote terminfo when `tic` is available, keeps `TERM=xterm-ghostty` when installation succeeds, and falls back to `xterm-256color` otherwise. The Nix tools package includes `tic` and `infocmp`. Do not force `TERM` in SSH config or shell startup files; inside tmux, `TERM=tmux-256color` is intentional.

The tmux template relies on native terminal detection for truecolor, hyperlinks, and clipboard capabilities instead of appending overrides on every reload. Clipboard permission remains explicit: applications in all panes can overwrite the client clipboard when the terminal permits.

After changing SSH integration, open a fresh Ghostty window and SSH connection. Outside tmux, check `echo "$TERM"` and `infocmp xterm-ghostty`; inside tmux, check `tmux list-clients -F '#{client_termname} #{client_termfeatures}'`. Expect the outer Ghostty client to advertise `RGB`, `hyperlinks`, and `clipboard`. On an existing server, removing configuration lines does not remove previously appended overrides; validate automatic detection in a fresh isolated server before retiring an old server with active sessions.

## Slack reference

Setup does not configure Slack. These strings are reference material and may need adjustment for Slack's current interface.

- Dark: `#282828,#3c3836,#fe8019,#282828,#504945,#ebdbb2,#b8bb26,#fb4934,#1d2021,#ebdbb2`
- Light: `#fbf1c7,#ebdbb2,#af3a03,#fbf1c7,#d5c4a1,#3c3836,#79740e,#9d0006,#f9f5d7,#3c3836`
