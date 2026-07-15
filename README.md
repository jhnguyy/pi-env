# pi-env

Personal [pi](https://github.com/badlogic/pi-mono) environment — extensions, skills, themes, and agent context as a dotfiles repo. Shared as a reference; setups are inherently personalized.

## Mission

`pi-env` is a portable agent workbench: reusable tools, skills, workflows, and UI affordances for different environments.

Core design rule:

> Method and storage are separate.

Portable components define reusable practice. Local adapters define storage, credentials, paths, indexes, privacy boundaries, and machine-specific defaults. Reusable skills should discover local policy before reading or writing durable state.

## Setup choices

Nub is the canonical JavaScript toolchain. Nix remains available for host/runtime provisioning.

| Environment | Command |
| --- | --- |
| Fresh machine with local Nix + flakes | `nix run github:jhnguyy/pi-env#bootstrap -- ~/pi-env` |
| Existing checkout with local Nix | `nix run .#setup` or `./setup.sh --use-nix` |
| Externally Nix-managed runtime/container | `./setup.sh --nix-managed` |
| No Nix | `./setup.sh` |

`--use-nix` means “invoke local Nix now.” Use it only when the machine can realize Nix store paths. `--nix-managed` means “Nix already provided the toolchain/config ownership boundary.” It does not call `nix run`; it uses existing host tools.

Portable fallback setup intentionally uses whatever tools are already on `PATH`. Setup is safe to re-run after moving between dev environments and preserves machine-local pi auth, model choices, and local overrides.

## Documentation

Repository conventions and area-specific documentation live under `docs/`.

## Theme snippets

Slack custom theme strings:

- Gruvbox Dark: `#282828,#3c3836,#fe8019,#282828,#504945,#ebdbb2,#b8bb26,#fb4934,#1d2021,#ebdbb2`
- Gruvbox Light: `#fbf1c7,#ebdbb2,#af3a03,#fbf1c7,#d5c4a1,#3c3836,#79740e,#9d0006,#f9f5d7,#3c3836`
