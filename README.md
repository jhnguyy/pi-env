# pi-env

Personal [pi](https://github.com/badlogic/pi-mono) environment — extensions, skills, themes, and agent context as a dotfiles repo. Shared as a reference. Setups are inherently personalized.

## Mission

`pi-env` is a portable agent workbench: reusable tools, skills, workflows, and UI affordances for different environments.

Core design rule:

> Method and storage are separate.

Portable components define reusable practice. Local adapters define storage, credentials, paths, indexes, privacy boundaries, and machine-specific defaults. Reusable skills should discover local policy before reading or writing durable state.

## Setup choices

Nix supplies the workbench and packages Pi through its upstream flake. Nub installs repository dependencies and runs scripts. Without Nix, Nub supplies the portable runtime path. See [Nix ownership](docs/nix.md).

| Environment | Command |
| --- | --- |
| Fresh machine with local Nix + flakes | `nix run github:jhnguyy/pi-env#bootstrap -- ~/pi-env` |
| Existing checkout with local Nix | `nix run .#setup` or `./setup.sh --use-nix` |
| Externally Nix-managed runtime/container | `./setup.sh --nix-managed` |
| No Nix | `./setup.sh --portable` |

`--use-nix` means “invoke local Nix now.” Use it only when the machine can realize Nix store paths. `--nix-managed` means “Nix already provided the toolchain/config ownership boundary.” It does not call `nix run`. It uses existing host tools.

Ordinary setup preserves personal settings and registers pi-env through Pi's package manager. Fresh setup uses the [initial baseline](setup/managed-settings-core.mjs). Every run reapplies managed stall timeouts and retry settings so hung provider requests fail fast into Pi's retry. Pi owns transport, image handling, and appearance.

Run `./setup.sh --reset` to back up user settings and restore this baseline with only pi-env registered. Auth, sessions, model endpoints, MCP configuration, keybindings, and project settings remain untouched. Reinstall local adapter packages afterward. See [setup and reset](docs/setup.md).

Use `pi config` to select package resources. Use `/skill:pi-update` to review a proposed upstream release before changing the workbench. Ghostty and tmux palettes remain available through terminal setup.

## Documentation

Repository conventions and area-specific documentation live under `docs/`.

## License

pi-env is available under the [MIT License](LICENSE).
See [third-party notices](THIRD_PARTY_NOTICES.md) for incorporated material.

## Theme snippets

Slack custom theme strings:

- Gruvbox Dark: `#282828,#3c3836,#fe8019,#282828,#504945,#ebdbb2,#b8bb26,#fb4934,#1d2021,#ebdbb2`
- Gruvbox Light: `#fbf1c7,#ebdbb2,#af3a03,#fbf1c7,#d5c4a1,#3c3836,#79740e,#9d0006,#f9f5d7,#3c3836`
