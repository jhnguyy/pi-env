# Contributing

Start with [README](README.md) for setup modes and the [code-contribution skill](skills/code-contribution/SKILL.md) for the contribution workflow. This page adds pi-env's development requirements.

## Prepare a checkout

Use Node compatible with [`package.json#engines`](package.json) and Nub on `PATH`. Check the [prerequisites](docs/prerequisites.md) and follow the [setup guidance](docs/setup.md) for Nix-managed or portable environments.

Keep dependency links and generated bundles local to each checkout. Installation runs [hydration](scripts/hydrate.mjs). For an additional worktree, initialize those artifacts:

```bash
nub run --no-check worktree:init
```

Global setup changes your personal environment and is not a worktree-initialization fallback. If initialization fails, diagnose the toolchain or report the blocker rather than sharing another checkout's dependencies.

## Develop

Follow the [extension conventions](docs/conventions/extensions.md) for package registration, runtime boundaries, and shared services. Pi loads generated bundles, so build changes before exercising them in a Pi session:

```bash
nub run build
```

Reload or restart that session afterward. For dev-tools, run
`nub run dev-tools:restart` in the same environment as Pi; the next request starts
the updated daemon.

For activated Nix artifacts, follow [host integration](docs/setup.md#declarative-host-integration) instead of assuming a checkout build replaces them.

Keep tests and setup experiments isolated from personal homes, agent directories, settings, and sessions. Use the [dependency-update skill](skills/dependency-update/SKILL.md) when changing dependencies and the [documentation conventions](docs/conventions/documentation.md) when changing documentation.

## Verification

Inspect the change-scoped plan, then run it:

```bash
nub run verify --list
nub run verify
```

Use `--base <ref>` to choose the comparison and `--checks-only` to omit tests. Routine verification runs formatting, shell syntax, source-pattern checks, native lint sensors, and related unit tests as selected by the delta; it does not launch Analyze. The commit hook runs checks only. Verification holds the heavyweight lock while running its selected checks.

`nub run sensors` runs native lint sensors only. Run `nub run lint:type` for full lint qualification, including import resolution and type-aware rules. Select [Analyze investigations](docs/analyze.md#on-demand-investigations) explicitly when their findings would inform a decision; they are not prerequisites for routine verification.

Local verification selects related unit tests. An integration-only edit may select no runnable unit tests, and generated artifacts or dynamic inputs can escape import-based selection. Choose qualification for the affected contracts:

| Evidence                        | Command                           |
| ------------------------------- | --------------------------------- |
| Focused units                   | `nub run test:unit <file>`        |
| Focused integration             | `nub run test:integration <file>` |
| Setup shell workflows           | `nub run test:setup`              |
| Regular native SDK and LSP E2Es | `nub run test:workflows`          |
| Real-workspace canary           | `nub run test:canary`             |
| Broader CI integration pipeline | `nub run verify:full`             |

Vitest aliases invoke the runner directly; Vitest owns selection, workers, and test lifecycle. `typecheck` and `lint:type` invoke the upstream Effect compiler and Oxlint entrypoints. Standalone test, typecheck, and full-lint commands do not acquire the cross-worktree heavyweight lock or use the supervisor's command timeout and process-group cleanup. `verify` retains its outer lock, and `verify:full` retains both locking and command supervision. `PI_ENV_TEST_TIMEOUT_MS` and `PI_ENV_TEST_KILL_GRACE_MS` apply only to supervised commands.

CI runs `verify:full`; select the canary and Docker qualification separately when relevant.

[Testing conventions](docs/conventions/testing.md) cover organization, fixtures, and qualification boundaries. [`package.json#scripts`](package.json) owns executable commands.

## Submit a change

Use the [pull request template](.github/pull_request_template.md) to explain the behavioral outcome, relevant design choices, and validation. Distinguish checks that passed from qualification still pending, and retain useful failure evidence. Passing source tests does not establish that a built extension or activated host environment loaded the change.
