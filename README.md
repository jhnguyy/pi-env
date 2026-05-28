# pi-env

Personal [pi](https://github.com/badlogic/pi-mono) environment — extensions, skills, themes, and agent context as a dotfiles repo. Shared as a reference; setups are inherently personalized.

## Setup

Prerequisites: `git`, Node.js ≥ 22.19, and npm ≥ 10. The repo includes `.node-version` / `.nvmrc` pinned to `22.19.0`.

```bash
git clone <your-fork> ~/pi-env
cd ~/pi-env
export PATH="$HOME/.local/bin:$PATH"   # add to ~/.profile to persist
./setup.sh
```

`setup.sh` is self-documenting — its header lists everything it does and what it leaves alone. In short, it installs the `pi` CLI with npm into a user-local prefix, installs repo dependencies, builds extension bundles, and registers pi-env as a package.

## Pi CLI install

`setup.sh` installs `@earendil-works/pi-coding-agent` with npm into `~/.local/share/pi-env/pi-cli` and writes `~/.local/bin/pi`. The wrapper runs Pi's Node entrypoint.

## Themes

This package registers the `themes/` directory with pi. Select `gruvbox-dark` or `gruvbox-light` in `/settings`, or set `"theme"` in `settings.json`.

To switch automatically by time of day, enable the theme scheduler in `settings.json`:

```json
{
  "themeScheduler": {
    "enabled": true,
    "lightTheme": "gruvbox-light",
    "darkTheme": "gruvbox-dark",
    "lightStart": "10:00",
    "lightEnd": "16:00"
  }
}
```

The scheduler defaults to off. When enabled, `lightStart` is inclusive and `lightEnd` is exclusive, so the defaults use light mode from 10:00 through 15:59 and dark mode otherwise.

Slack custom theme strings:

- Gruvbox Dark: `#282828,#3c3836,#fe8019,#282828,#fbf1c7,#ebdbb2,#b8bb26,#fb4934,#1d2021,#ebdbb2`
- Gruvbox Light: `#fbf1c7,#ebdbb2,#af3a03,#fbf1c7,#282828,#3c3836,#79740e,#9d0006,#f9f5d7,#282828`

## Further reading

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — branch conventions, building extensions, worktree workflow
- **[pi docs](https://github.com/badlogic/pi-mono)** — upstream reference for the extensions API, skills spec, and settings
