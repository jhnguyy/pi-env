# Gruvbox themes

## Pi

Setup registers the [Pi themes](../themes/). Fresh setup and explicit reset select the [baseline theme](../setup/managed-settings-core.mjs); ordinary setup preserves personal choices.

Use `/settings` to choose a theme, or `system` to follow terminal colors. After a package update, use `/reload`. If themes are missing, check their availability with `pi config`.

## Terminals

[Terminal setup](../setup/terminal-config.mjs) installs Ghostty's light/dark palettes on GUI hosts and a tmux style that follows the background each client reports, treating an unknown background as dark. Set `PI_ENV_LINK_GHOSTTY=1` to install Ghostty files elsewhere.

Keep Ghostty overrides in `~/.config/ghostty/config.local`. Reload Ghostty after setup and run `ghostty +validate-config`.

For Home Manager, enable `pi-env.ghostty.enable` and switch generations instead of letting setup manage those files. Other terminal applications have no setup integration.

### Chrome roles

Chrome uses a tonal surface hierarchy with container/text pairs rather than accent-colored ordinary text: content on bg0, bars on bg1, raised containers on bg2, and focus as an orange container with bg0 text. The [palettes](../themes/) own the colors, and the [tmux template](../setup/templates/tmux.conf) maps its native color slots to these roles.

When changing chrome, meet [W3C's 4.5:1 normal-text target](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) and [3:1 nontext indicator target](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html). Orange text on bg2 falls short, so use the focus container pair instead. Surface steps are intentionally subtle and are not focus indicators on their own.

### Bash prompt

The optional [prompt fragment](../setup/templates/bash-prompt.sh) owns `PS1` and takes its colors from the terminal palette. Setup does not install it. Source it from your interactive shell configuration, or with Home Manager enable `pi-env.shell.bashPrompt.enable` alongside `programs.bash.enable`. Disable it before choosing another prompt.

### Ghostty over SSH and tmux

The [Ghostty config](../ghostty/config) enables native SSH terminfo integration, and the tmux template relies on native terminal capability detection. Do not force `TERM` in SSH config or shell startup files.

After changing SSH or terminal integration, check in a fresh Ghostty window and SSH connection: `echo "$TERM"` and `infocmp xterm-ghostty` outside tmux, and `tmux list-clients -F '#{client_termname} #{client_termfeatures}'` inside. On an existing tmux server, removed configuration lines leave earlier overrides in place, so validate in a fresh isolated server.

## Slack reference

Setup does not configure Slack. Import one of these strings as a Slack custom theme. Slack's four colors (navigation, selected items, presence, notifications) map to bg0, orange focus, green, and red:

- Dark: `#282828,#fe8019,#b8bb26,#fb4934`
- Light: `#fbf1c7,#af3a03,#79740e,#9d0006`

Slack chooses text colors itself, so the chrome contrast targets above do not carry over. A custom theme does not follow the OS appearance: switch strings manually, or keep one string with a fixed Slack color mode.
