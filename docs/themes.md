# Gruvbox themes

pi-env supplies Gruvbox Light and Dark for Pi and Ghostty, a dark tmux style, and Slack reference strings.

## Pi

Setup registers the [Pi themes](../themes/) through `package.json`'s `pi.themes` resource declaration. It does not copy themes into the user agent directory.

Fresh setup and explicit reset select `gruvbox-light/gruvbox-dark`. Pi selects the variant from terminal appearance. If appearance detection is unavailable, Pi falls back to dark. Ordinary setup preserves existing theme settings, including `system` and custom themes.

Use `/settings` to select a theme. Select `system` to derive Pi colors from the terminal palette instead. Explicit Gruvbox themes keep their own text and panel colors even when the terminal uses a different palette.

After updating the package, run `/reload` or start a new Pi session. Package themes do not use Pi's user-theme file watcher. If Pi reports a missing Gruvbox theme, check that pi-env is registered and its theme resources are enabled with `pi config`.

## Terminals

[Terminal setup](../setup/terminal-config.mjs) installs both [Ghostty palettes](../ghostty/themes/) on GUI hosts. Set `PI_ENV_LINK_GHOSTTY=1` to request installation elsewhere. The Ghostty config follows the terminal's light/dark appearance.

Keep personal Ghostty overrides in `~/.config/ghostty/config.local`. If Home Manager owns terminal configuration, update its pi-env input and switch generations. Otherwise, rerun terminal setup. Reload Ghostty and run `ghostty +validate-config`.

The [Home Manager module](../nix/home-manager.nix) provides the same Ghostty files when `pi-env.ghostty.enable` is enabled. Setup skips terminal writes when configuration is externally managed or terminal setup is disabled.

The [tmux config](../setup/templates/tmux.conf) supplies a fixed dark style. It does not install a terminal ANSI palette or follow light/dark changes. Other terminal applications do not have setup integrations.

Pi detects terminal capabilities itself. Theme installation does not force hyperlinks, image protocols, or truecolor support through terminal paths that might not support them.

## Slack reference

Copy the appropriate string into Slack's custom theme settings. Setup does not configure Slack. These reference strings are not validated against Slack's current interface.

- Gruvbox Dark: `#282828,#3c3836,#fe8019,#282828,#504945,#ebdbb2,#b8bb26,#fb4934,#1d2021,#ebdbb2`
- Gruvbox Light: `#fbf1c7,#ebdbb2,#af3a03,#fbf1c7,#d5c4a1,#3c3836,#79740e,#9d0006,#f9f5d7,#3c3836`

## Validation

Run `bash setup/__tests__/themes.test.sh` to check package discovery, theme loading, fresh/reset selection, and preservation of personal choices. The workflow prints its evidence directory.

For terminal installation checks, run `bash setup/__tests__/ghostty-config.test.sh`. Runtime Ghostty checks require the Ghostty executable.
