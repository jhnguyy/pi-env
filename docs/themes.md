# Gruvbox themes

## Pi

Setup registers the [Pi themes](../themes/). Fresh setup and explicit reset select `gruvbox-light/gruvbox-dark`. Ordinary setup preserves personal choices.

Use `/settings` to choose a theme, or `system` to follow terminal colors. After a package update, use `/reload`. If themes are missing, check their availability with `pi config`.

## Terminals

[Terminal setup](../setup/terminal-config.mjs) installs Ghostty's light/dark palettes on GUI hosts and a tmux style that follows the background each client reports, treating an unknown background as dark. Set `PI_ENV_LINK_GHOSTTY=1` to install Ghostty files elsewhere.

Keep Ghostty overrides in `~/.config/ghostty/config.local`. Reload Ghostty after setup and run `ghostty +validate-config`.

For Home Manager, enable `pi-env.ghostty.enable` and switch generations instead of letting setup manage those files. Other terminal applications have no setup integration.

## Slack reference

Setup does not configure Slack. These strings are reference material and may need adjustment for Slack's current interface.

- Dark: `#282828,#3c3836,#fe8019,#282828,#504945,#ebdbb2,#b8bb26,#fb4934,#1d2021,#ebdbb2`
- Light: `#fbf1c7,#ebdbb2,#af3a03,#fbf1c7,#d5c4a1,#3c3836,#79740e,#9d0006,#f9f5d7,#3c3836`
