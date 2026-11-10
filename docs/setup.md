# Setup reference

For installation modes and commands, start with [README](../README.md#setup-choices). Normal setup registers pi-env and preserves personal settings except the managed stall-timeout and retry keys, which every run reapplies so hung provider requests fail fast into Pi's retry. Use project settings to override those keys.

[Managed settings](../setup/managed-settings-core.mjs) owns the initial baseline and managed keys; use `pi config` to select package resources.

Package resource selections name paths inside pi-env. Setup moves pi-env's selections in your user settings from `.pi/extensions/` and `.agents/skills/` to `extensions/` and `skills/`. Update any project settings that select pi-env resources by those older paths yourself.

Normal setup does not enable Atuin capture. See [Atuin capture](atuin.md) for declarative host integration, privacy considerations, and onboarding responsibilities.

## Explicit reset

Run `./setup.sh --reset` to back up existing settings and restore the baseline with only pi-env registered. Reset replaces only `settings.json`; other agent-directory files and project settings remain. Reinstall local adapters afterward; adapter setup must not reset the base implicitly.

See [settings registration and rollback](../setup/apply-managed-settings.mjs) for backup and failure handling.

## System instructions

After updating guidance, rerun setup, then start a new Pi session or use `/reload`. A trusted project `.pi/APPEND_SYSTEM.md` overrides the agent-directory file.

See [the philosophy](../setup/templates/APPEND_SYSTEM.md), [guidance installation](../setup/pi-config.mjs), and [managed-block preservation rules](../setup/managed-block.mjs).

## Runtime integration

`PI_CODING_AGENT_DIR` selects user state; `PI_AGENT_DIR` is a legacy alias. Conflicting selections are rejected. See [directory resolution](../setup/agent-dir.sh).

The [runtime adapter](../setup/runtime.mjs) owns CLI installation and session launching. [Hydration](../scripts/hydrate.mjs) prepares dependency-install artifacts. In Nix-backed setups, the [package outputs](../nix/outputs.nix) distinguish a tools-only environment from a toolchain that also supplies Pi. Keeping those outputs separate lets infrastructure provision tools without taking ownership of the application's revision.

### Declarative host integration

The exported [Home Manager module](../nix/home-manager.nix) can provision Pi and terminal integration from a locked flake input. When it does, editing a working checkout does not replace those activated artifacts. Update the consuming input and activate its generation when those are the intended changes. Builder access, binary-cache trust, and host activation belong to that consuming infrastructure, not portable setup; use isolated state rather than a live profile to validate setup changes.

With `pi-env.homeManager.sync.enable`, setup reports when the consuming flake's pi-env input differs from `main`. Setup also runs from the post-merge hook, so it updates the input and switches generations only when you pass `--sync-home-manager`. See [Home Manager sync](../setup/home-manager.mjs) for the conditions it checks.

### Externally managed tools with checkout-owned Pi

An external provisioner can supply Node, Nub, and command-line tools through `packages.<system>.tools`. Pi then comes from the checkout's Nub-installed dependencies, not the Nix Pi package.

For a container that exposes Node at the stable path `/bin/node`, run setup from the writable checkout:

```bash
unset PI_PACKAGE_DIR PI_ENV_PI_EXECUTABLE PI_ENV_CLI_MANAGED_BY_NIX
export PI_ENV_NODE_BIN=/bin/node
export NODE_EXECUTABLE=/bin/node
./setup.sh --nix-managed
```

The provisioner must make `/bin/node` executable and put Nub and the other tools on `PATH`. For another layout, use its stable Node path for both variables. Setup records that path in the Pi wrapper. Do not supply a generation-specific Nix store path for this mode.

Leave `PI_PACKAGE_DIR` and `PI_ENV_PI_EXECUTABLE` unset during setup and subsequent sessions. Do not enable `PI_ENV_CLI_MANAGED_BY_NIX`: setup must write the user-local Pi wrapper. The provisioner must put `${PI_BIN_DIR:-$HOME/.local/bin}` before other Pi executables on `PATH`. `--nix-managed` leaves shell profiles and terminal configuration to the provisioner. See [runtime integration](#runtime-integration) for setup implementation owners.

After updating the application checkout, rerun the same setup command. Reuse the tools package while it satisfies the checkout's [runtime requirements](../package.json). The consumer owns source revision selection, persistent state, setup sequencing, and session restarts. Existing sessions do not reload the updated runtime automatically.

## Gruvbox themes

See [themes](themes.md) for Pi selection, terminal installation, and Slack reference strings.
