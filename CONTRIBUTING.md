# Contributing

pi-env is a package loaded into Pi, not an application with one self-contained runtime. A change can involve TypeScript source, generated extension bundles, a host-provided SDK, and user state outside the checkout. Understanding which of those the change reaches matters more than adopting the maintainer's personal development setup.

## From checkout to running extension

Pi loads built extension bundles, while many tests import source directly. Editing a source file or passing a source-level test does not mean an existing Pi session has loaded the change. Dependencies and generated bundles need to match the checkout being exercised; sharing them between different revisions can make the running behavior disagree with the source under review.

Dependency installation also prepares runtime artifacts. The install-time [hydration](scripts/hydrate.mjs) patches the Effect language service, builds bundles, and restarts the LSP daemon. It is more than downloading packages. The checkout initialization command, `nub run --no-check worktree:init`, provides dependency isolation and install validation when preparing an additional worktree; it is not a requirement to use that checkout layout.

An extension participates through package registration, workspace membership, and its bundle entrypoints. [Extension conventions](docs/conventions/extensions.md) explain those relationships and the shared lifecycle boundary. Pi peer packages are externalized so bundles use the host SDK rather than introducing independent runtime copies. Updating Pi therefore involves compatibility between the host release and the development SDK packages, not only a dependency edit. The Nix input and development packages are version-checked together; the [release collector](scripts/collect-pi-release-evidence.mjs) can gather matching upstream release material for that assessment.

## Development is not a separate user environment

A temporary working directory does not isolate Pi's agent directory, settings, sessions, or shared services. Tests and setup experiments can otherwise reach personal state even when their source checkout is separate. Settings integration can also use synthetic settings. Validate setup with isolated homes and agent directories rather than resetting personal settings or activating a live host profile; an intentional deployment is a separate action with different effects and responsibilities.

Toolchain provisioning is another boundary. Pi may come from Nix or from the checkout's installed dependencies. A container supplied with Nix-built tools does not necessarily have permission to realize store paths or activate a host generation. [Setup modes](README.md#setup-choices) and [runtime integration](docs/setup.md#runtime-integration) describe those choices without requiring contributors to reproduce a particular host.

## Verification

`nub run verify` provides change-scoped checks and unit-test feedback. Use `--list` to inspect the selection, `--base <ref>` to choose the comparison, or `--checks-only` to omit tests. `nub run test` also defaults to the unit project. Unit classification is not a capacity guarantee; review fixture and import costs when adding coverage. Commands and the broader sequence live in [`package.json#scripts`](package.json).

Keep executable fixtures in typed source files rather than embedded program strings so repository checks can inspect them. Name integration tests `*.integration.test.ts` (or `*.integration.test.mjs` for JavaScript suites) to match the Vitest project selection. For setup or migration idempotency, rerun against the state produced by the first run and check that the promised result remains unchanged.

Integration, setup-shell (`nub run test:setup`), and E2E suites are explicitly selected, even when they import changed source or belong to its component. An integration-only edit may therefore select no runnable unit tests; successful local feedback does not qualify that integration test. Select the relevant file directly, for example:

```bash
nub run test:integration src/process/__tests__/platform.integration.test.ts
```

`nub run test:workflows` selects the regular non-Docker E2E project, including built-bundle native SDK workflows and real LSP qualification. Use `nub run test:e2e .pi/extensions/dev-tools/__tests__/e2e.test.ts` to select the LSP workflow alone. Build matching artifacts first when the selected workflow loads bundles.

The local verify plan supplies serial-worker and fail-fast flags to its test step; the shared Vitest configuration does not impose them on CI. `--checks-only` still runs native lint and Analyze, so it retains the heavyweight lock rather than overlapping those workloads with another worktree's full run.

CI combines changed-file policy with `nub run verify:full` for integration coverage. Local selection cannot reliably discover every consequence of configuration, dependency, generated-artifact, or dynamic-input changes. A green local result describes the evidence obtained, not everything that remains unaffected.

Broad work can exhaust a shared machine even with low test concurrency. [Analyze's public entrypoint](src/analyze/public.ts) admits bounded syntax work to a supervised worker and refuses strict capabilities without aggregate containment. Its process groups cannot contain detached descendants, and syntax budgets do not make a changing filesystem a security sandbox. Those safeguards do not apply to arbitrary package commands, native linters, or subprocesses started elsewhere. Choose capacity and isolation for the workload rather than inferring safety from a command name or worker setting.

Some behavior needs environment qualification beyond ordinary source tests. `nub run test:canary` exercises dev-tools against the real workspace; `nub run test:e2e:session-manager:docker` exercises real Pi session ownership in an isolated tmux environment. Their evidence is useful when the change reaches those boundaries, not as a ritual for every edit.

[Testing conventions](docs/conventions/testing.md) explain how to choose and assess evidence. [Documentation conventions](docs/conventions/documentation.md) explain what durable guidance should add beyond the code and its checks.
