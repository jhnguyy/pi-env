# Setup reference

For installation modes and commands, start with [README](../README.md#setup-choices). Normal setup registers pi-env and preserves personal settings except managed network and retry keys, which are reapplied on every run. Use project settings to override those keys.

[Managed settings](../setup/managed-settings-core.mjs) owns the initial baseline and managed keys; use `pi config` to select package resources.

## Explicit reset

Run `./setup.sh --reset` to back up existing settings and restore the baseline with only pi-env registered. Auth, sessions, and project settings are not reset. Reinstall local adapters afterward; adapter setup must not reset the base implicitly.

See [settings registration and rollback](../setup/apply-managed-settings.mjs) for backup and failure handling.

## System instructions

After updating guidance, rerun setup, then start a new Pi session or use `/reload`. A trusted project `.pi/APPEND_SYSTEM.md` overrides the agent-directory file.

See [the philosophy](../.pi/agent/APPEND_SYSTEM.md), [guidance installation](../setup/pi-config.mjs), and [managed-block preservation rules](../setup/managed-block.mjs).

## Runtime integration

`PI_CODING_AGENT_DIR` selects user state; `PI_AGENT_DIR` is a legacy alias. Conflicting selections are rejected. See [directory resolution](../setup/agent-dir.sh).

[Nix bindings](../nix/outputs.nix) provide the managed runtime. The [runtime adapter](../setup/runtime.mjs) owns CLI installation and session launching; [hydration](../scripts/hydrate.mjs) owns dependency-install preparation.

## Gruvbox themes

Setup makes Gruvbox themes available through the Pi package. Fresh setup and explicit reset select `gruvbox-light/gruvbox-dark`. Ordinary setup preserves personal theme choices.

See [themes](themes.md) for Pi selection, terminal installation, Home Manager ownership, and Slack reference strings.

## Workflow evidence

Run the focused workflow for the behavior under investigation:

- Settings/reset: `bash setup/__tests__/settings-reset.test.sh`
- Guidance updates: `bash setup/__tests__/append-system.test.sh`
- Pi themes: `bash setup/__tests__/themes.test.sh`
- Ghostty: `bash setup/__tests__/ghostty-config.test.sh`

Each prints a retained evidence directory. See [setup testing](../setup/__tests__/README.md) and [verification requirements](../CONTRIBUTING.md#testing-and-review) for broader checks.
