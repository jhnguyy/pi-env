# pi-env

Personal [pi](https://github.com/badlogic/pi-mono) environment — extensions, skills, themes, and agent context as a dotfiles repo. Shared as a reference. Setups are inherently personalized.

## Mission

`pi-env` is a portable agent workbench: reusable tools, skills, workflows, and UI affordances for different environments.

Core design rule:

> Method and storage are separate.

Portable components define reusable practice. Local adapters define storage, credentials, paths, indexes, privacy boundaries, and machine-specific defaults. Reusable skills should discover local policy before reading or writing durable state.

## Setup choices

The operating environment supplies Node and Nub. `pi-env` declares the compatible Node range in `package.json#engines.node` and the Nub version in `package.json#packageManager`. Setup checks the resolved tools against those requirements. Nub installs dependencies and builds Pi from the local checkout; Node runs Pi. The checkout-level setup and verification commands have the same meaning on development machines, in the Kubernetes image, and on the break-glass host.

Nix can supply the declared toolchain through `.#toolchain`, `nix develop`, and the optional Home Manager module. The Kubernetes image, a NixOS VM or LXC, and a development machine can use different delivery mechanisms. No environment must run Home Manager inside itself to use `pi-env`.

| Environment | Command |
| --- | --- |
| Fresh machine with local Nix + flakes | `nix run github:jhnguyy/pi-env#bootstrap -- ~/pi-env` |
| Existing checkout with local Nix | `nix run .#setup` or `./setup.sh --use-nix` |
| Externally Nix-managed runtime/container | `./setup.sh --nix-managed` |
| No Nix | `./setup.sh` |

`--use-nix` invokes local Nix and requires access to realizable store paths. `--nix-managed` uses tools already supplied by the environment without calling `nix run`. Neither option delegates dependency installation or Pi builds to Nix.

Portable fallback setup intentionally uses whatever tools are already on `PATH`. Setup is safe to re-run after moving between dev environments and preserves machine-local pi auth, model choices, and local overrides. It updates the pi-env guidance block in `~/.pi/agent/AGENTS.md` and preserves content outside the managed block.

Setup adds Pi's `codemode` and `tool_search` to `defaultTools` without replacing existing tool choices or explicit opt-outs. It leaves `theme` unset so Pi follows the terminal palette. Setup removes selections of the retired pi-env Pi Gruvbox themes; other themes remain unchanged. Ghostty and tmux palettes remain available through terminal setup. Setup installs Ghostty palettes under its standard Linux or macOS configuration directory when terminal setup is enabled. Set `GHOSTTY_CONFIG_DIR` to override that path. Pi no longer loads local Pi theme files.

## Documentation

Repository conventions and area-specific documentation live under `docs/`.

## License

pi-env is available under the [MIT License](LICENSE).
See [third-party notices](THIRD_PARTY_NOTICES.md) for incorporated material.

## Theme snippets

Slack custom theme strings:

- Gruvbox Dark: `#282828,#3c3836,#fe8019,#282828,#504945,#ebdbb2,#b8bb26,#fb4934,#1d2021,#ebdbb2`
- Gruvbox Light: `#fbf1c7,#ebdbb2,#af3a03,#fbf1c7,#d5c4a1,#3c3836,#79740e,#9d0006,#f9f5d7,#3c3836`
