# Setup settings and reset

Normal setup registers pi-env through Pi's stock package manager and preserves existing personal settings. A missing user settings file receives the baseline from `setup/managed-settings-core.mjs`. There is no repeatedly applied preference overlay.

Read the [baseline owner](../setup/managed-settings-core.mjs) for initial preference values. Provider selection inspects stored authentication type metadata without resolving keys or refreshing tokens. It prefers authenticated `openai`, then authenticated `openai-codex`, and defaults to `openai` when neither is configured.

## Explicit reset

Run `./setup.sh --reset` to replace user settings with the baseline and only pi-env registered. An existing file is backed up verbatim beside it as `settings.json.backup-<timestamp>` with user-only permissions. Registration failure restores the original file. Backups remain available after failure.

Reset does not replace auth, sessions, model endpoints, MCP configuration, keybindings, installed package files, or project settings. Project settings can still override the user baseline. Standard setup's managed guidance updates still apply.

Reinstall local adapters after reset. Their setup can invoke the base setup first, then register their own package and local configuration. Routine adapter setup must not implicitly reset the base.

Package registration uses the primary checkout when setup runs from a temporary worktree. Pi's stock `pi config` owns resource selection, including extension and skill toggles.

## Runtime integration

Normal dependency installation relies on the shared postinstall hydration operation. When Nub cannot execute the selected runtime, setup installs with `--ignore-scripts` and invokes the same hydration operation through the provisioned Node. Setup does not separately repeat builds or daemon restarts.

The [Nix bindings](../nix/outputs.nix) supply Pi's package metadata and upstream executable. The [session adapter](../setup/runtime.mjs) delegates ordinary invocations to that executable, preserving its runtime environment. Portable setup uses the package-declared Node entrypoint. Exact `pi --start` invokes session selection and launches the selected session through the same adapter.

Pi's `PI_CODING_AGENT_DIR` selects user state. Base setup also accepts the legacy `PI_AGENT_DIR` alias. Conflicting selections fail before provisioning or settings writes. Relative paths resolve before setup changes the working directory.

## Ghostty and Gruvbox

The Gruvbox palettes remain in [`ghostty/themes/`](../ghostty/themes/). Setup and Home Manager install them under `$XDG_CONFIG_HOME/ghostty/themes`, or `~/.config/ghostty/themes` by default. Ghostty searches this directory for named themes even when its main config lives in macOS Application Support.

On macOS, the main config lives in `~/Library/Application Support/com.mitchellh.ghostty/config`. On Linux, setup uses `~/.config/ghostty/config`. Optional overrides live in `config.local` beside the main config. `GHOSTTY_CONFIG_DIR` overrides setup's main config location, not the theme search directory.

If Home Manager owns terminal configuration, update its pi-env input and switch the Home Manager generation. Otherwise, rerun terminal setup. Reload Ghostty after installation. Run `ghostty +validate-config` to check the active configuration.

The removal in #154 deleted the legacy Pi `gruvbox.json` theme. The removal in #459 deleted Pi's separate light/dark JSON themes and adopted Pi's terminal-derived appearance. Neither change removed the Ghostty palettes. Keep terminal colors in Ghostty rather than restoring a separate Pi theme with duplicate colors.

Run `bash setup/__tests__/ghostty-config.test.sh` for isolated installation evidence. It checks macOS and XDG config layouts, theme links, and repeat setup. If Ghostty is installed, it also validates theme loading, palette colors, and adjacent overrides. Set `PI_ENV_TEST_GHOSTTY_BIN` to select an executable. The printed evidence directory retains logs and `result.json`.

## Workflow evidence

Run `PI_ENV_REPO=$PWD bash setup/__tests__/settings-reset.test.sh` for isolated settings/reset evidence. It prints a retained directory containing before/after settings, backups, a workflow log, and `result.json`. Set `PI_ENV_SETUP_EVIDENCE_DIR` to choose an existing parent directory. The workflow uses a temporary home, not live user settings. It exercises the real configuration and registration stage without dependency provisioning or hooks. Legacy-JSON preservation and both normal/reset rollback run in this same workflow. Failure artifacts retain the phase, exit status, snapshots, and assertion log.

The separate launcher, runtime, worktree, and supplied-package probes cover boundaries that cannot be induced reliably by normal setup without changing a provisioner or starting an interactive session. They retain their inputs and outputs. They do not replace full setup validation or duplicate hydration with a fake implementation.
