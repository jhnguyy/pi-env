# Contributing

Start with [README](README.md) for setup modes and the [code-contribution skill](skills/code-contribution/SKILL.md) for the contribution workflow. This page adds pi-env's development requirements.

## Prepare a checkout

Use Node compatible with [`package.json#engines`](package.json) and Nub on `PATH`. Check the [prerequisites](docs/prerequisites.md) and follow the [setup guidance](docs/setup.md) for Nix-managed or portable environments.

Keep dependency links and generated bundles local to each checkout. Installation runs [hydration](scripts/hydrate.mjs). For an additional worktree, initialize those artifacts:

```bash
nub run --no-check worktree:init
```

## Develop

Follow the [extension conventions](docs/conventions/extensions.md) for package registration, runtime boundaries, and shared services. Pi loads generated bundles, so build changes before exercising them in a Pi session:

```bash
nub run build
```

Reload or restart that session afterward. For activated Nix artifacts, follow [host integration](docs/setup.md#declarative-host-integration) instead of assuming a checkout build replaces them.

Keep tests and setup experiments isolated from personal homes, agent directories, settings, and sessions. Use the [dependency-update skill](skills/dependency-update/SKILL.md) when changing dependencies and the [documentation conventions](docs/conventions/documentation.md) when changing documentation.

## Verification

Inspect the change-scoped plan, then run it:

```bash
nub run verify --list
nub run verify
```

Use `--base <ref>` to choose the comparison and `--checks-only` to omit tests. Routine verification runs formatting, shell syntax, source-pattern checks, native lint sensors, and related unit tests as selected by the delta; it does not launch Analyze. The commit hook runs checks only. Verification holds the heavyweight lock while running its selected checks.

`nub run sensors` runs native lint sensors only. Run `nub run lint:type` for full lint qualification, including import resolution and type-aware rules. Oxlint configuration owns shared lint policy; package scripts declare job-specific scope, and the existing supervisor manages process execution. Select [Analyze investigations](docs/analyze.md#on-demand-investigations) explicitly when their findings would inform a decision; they are not prerequisites for routine verification.

Local verification selects related unit tests. An integration-only edit may select no runnable unit tests, and generated artifacts or dynamic inputs can escape import-based selection. Choose qualification for the affected contracts:

| Evidence                           | Command                                   |
| ---------------------------------- | ----------------------------------------- |
| Focused units                      | `nub run test:unit <file>`                |
| Focused integration                | `nub run test:integration <file>`         |
| Setup shell workflows              | `nub run test:setup`                      |
| Regular native SDK and LSP E2Es    | `nub run test:workflows`                  |
| Real-workspace canary              | `nub run test:canary`                     |
| Isolated session-manager/tmux E2Es | `nub run test:e2e:session-manager:docker` |
| Broader CI integration pipeline    | `nub run verify:full`                     |

Use a dedicated job with an OS-enforced aggregate memory budget and timeout for broad or type-aware qualification; a small target can still load a large project. Establish that boundary before launch. Supervision, serial execution, and Node heap limits do not provide that containment. When a suitable boundary is unavailable, report static checks separately and leave expensive runtime qualification pending. CI runs `verify:full`; select the canary and Docker qualification separately when relevant.

[Testing conventions](docs/conventions/testing.md) cover organization, fixtures, and qualification boundaries. [`package.json#scripts`](package.json) owns executable commands.

## Submit a change

Use the [pull request template](.github/pull_request_template.md) to explain the behavioral outcome, relevant design choices, and validation. Distinguish checks that passed from qualification still pending, and retain useful failure evidence. Passing source tests does not establish that a built extension or activated host environment loaded the change.
