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

[Nix bindings](../nix/outputs.nix) provide the local Nix runtime. The [runtime adapter](../setup/runtime.mjs) owns CLI installation and session launching. [Hydration](../scripts/hydrate.mjs) owns dependency-install preparation.

### Externally managed tools with checkout-owned Pi

An external provisioner can supply Node, Nub, and command-line tools through [`packages.<system>.tools`](nix.md#packages-and-ownership). Pi then comes from the checkout's Nub-installed dependencies, not the Nix Pi package.

For a container that exposes Node at the stable path `/bin/node`, run setup from the writable checkout:

```bash
unset PI_PACKAGE_DIR PI_ENV_PI_EXECUTABLE PI_ENV_CLI_MANAGED_BY_NIX
export PI_ENV_NODE_BIN=/bin/node
export NODE_EXECUTABLE=/bin/node
./setup.sh --nix-managed
```

The provisioner must make `/bin/node` executable and put Nub and the other tools on `PATH`. For another layout, use its stable Node path for both variables. Setup records that path in the Pi wrapper. Do not supply a generation-specific Nix store path for this mode.

Leave `PI_PACKAGE_DIR` and `PI_ENV_PI_EXECUTABLE` unset during setup and subsequent sessions. Do not enable `PI_ENV_CLI_MANAGED_BY_NIX`: setup must write the user-local Pi wrapper. The provisioner must put `${PI_BIN_DIR:-$HOME/.local/bin}` before other Pi executables on `PATH`. `--nix-managed` leaves shell profiles and terminal configuration to the provisioner. See [runtime integration](#runtime-integration) for setup implementation owners.

After updating the application checkout, rerun the same setup command. Reuse the tools package while it satisfies the checkout's [runtime requirements](../CONTRIBUTING.md#runtime-requirements). The consumer owns source revision selection, persistent state, setup sequencing, and session restarts. Existing sessions do not reload the updated runtime automatically.

## Gruvbox themes

See [themes](themes.md) for Pi selection, terminal installation, and Slack reference strings.

## Workflow evidence

Run the focused workflow for the behavior under investigation:

- Settings, reset, and Pi themes: `bash setup/__tests__/settings-reset.test.sh`
- Guidance updates: `bash setup/__tests__/append-system.test.sh`
- Ghostty: `bash setup/__tests__/ghostty-config.test.sh`

Each prints a retained evidence directory. See [setup testing](../setup/__tests__/README.md) and [verification requirements](../CONTRIBUTING.md#testing-and-review) for broader checks.
