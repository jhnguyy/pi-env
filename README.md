# pi-env

Personal [pi](https://github.com/badlogic/pi-mono) environment — extensions, skills, themes, and agent context as a dotfiles repo. Shared as a reference. Setups are inherently personalized.

## Mission

`pi-env` is a portable agent workbench: reusable tools, skills, workflows, and UI affordances for different environments.

Core design rule:

> Method and storage are separate.

Portable components define reusable practice. Local adapters define storage, credentials, paths, indexes, privacy boundaries, and machine-specific defaults. Reusable skills should discover local policy before reading or writing durable state.

## Setup choices

Nix supplies tools and can package Pi through its upstream flake. Nub installs repository dependencies and runs scripts. Without Nix, Nub supplies the portable runtime path. See [Nix ownership](docs/nix.md).

| Environment | Command |
| --- | --- |
| Fresh machine with local Nix + flakes | `nix run github:jhnguyy/pi-env#bootstrap -- ~/pi-env` |
| Existing checkout with local Nix | `nix run .#setup` or `./setup.sh --use-nix` |
| Externally Nix-managed runtime/container | `./setup.sh --nix-managed` |
| No Nix | `./setup.sh --portable` |

`--use-nix` means “invoke local Nix now.” Use it only when the machine can realize Nix store paths. `--nix-managed` means “Nix already provided the toolchain/config ownership boundary.” It does not call `nix run`. It uses existing host tools. For externally managed tools with Nub-installed Pi, follow the [external runtime setup contract](docs/setup.md#externally-managed-tools-with-checkout-owned-pi).

Ordinary setup preserves personal settings and registers pi-env through Pi's package manager. Fresh setup uses the [initial baseline](setup/managed-settings-core.mjs). Every run reapplies managed stall timeouts and retry settings so hung provider requests fail fast into Pi's retry. Pi owns transport, image handling, and theme selection.

Run `./setup.sh --reset` to back up user settings and restore this baseline with only pi-env registered. Auth, sessions, model endpoints, MCP configuration, keybindings, and project settings remain untouched. Reinstall local adapter packages afterward. See [setup and reset](docs/setup.md).

Use `pi config` to select package resources. Use `/skill:dependency-update` to assess a proposed dependency update.

## Documentation

Repository conventions and area-specific documentation live under `docs/`.

## License

pi-env is available under the [MIT License](LICENSE).
See [third-party notices](THIRD_PARTY_NOTICES.md) for incorporated material.
