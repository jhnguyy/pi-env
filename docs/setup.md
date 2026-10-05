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

## Workflow evidence

Run `PI_ENV_REPO=$PWD bash setup/__tests__/settings-reset.test.sh` for isolated settings/reset evidence. It prints a retained directory containing before/after settings, backups, a workflow log, and `result.json`. Set `PI_ENV_SETUP_EVIDENCE_DIR` to choose an existing parent directory. The workflow uses a temporary home, not live user settings. It exercises the real configuration and registration stage without dependency provisioning or hooks. Legacy-JSON preservation and both normal/reset rollback run in this same workflow. Failure artifacts retain the phase, exit status, snapshots, and assertion log.

The separate launcher, runtime, worktree, and supplied-package probes cover boundaries that cannot be induced reliably by normal setup without changing a provisioner or starting an interactive session. They retain their inputs and outputs. They do not replace full setup validation or duplicate hydration with a fake implementation.
