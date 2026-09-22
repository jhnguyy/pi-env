# Testing conventions

Permanent tests protect capabilities, regressions, or safety invariants. Test count is not a quality target, and moving slow safety coverage out of blocking verification is not a valid speedup.

## E2E-first workflow

Prefer end-to-end (E2E) scenarios as the sole behavioral evidence for a capability when they cover its requirements and material risks. Keep type, static policy, packaging, and install checks alongside behavioral evidence.

An E2E scenario enters through a supported user or operator interface, crosses the production boundaries relevant to its claim, and checks an externally observable result. Name that boundary and any substitutions. A configuration CLI scenario does not prove dependency installation. A local provider substitute does not prove hosted-provider behavior.

For new or changed behavior:

1. State the observable outcome, exact input, expected result, and material failure cases before implementation.
2. Select an existing E2E scenario or write a runnable acceptance scenario before changing production code. Establish a failing baseline where practical.
3. Implement the behavior and run the scenario through its declared entrypoint.
4. Verify the resulting artifacts against the expected outcomes. Use a negative control or regression red/green result to prove that the evidence detects the defect.
5. Name each remaining evidence gap. Add isolated tests only when an E2E scenario cannot safely or reliably establish that claim.
6. For each isolated-test exception, enumerate relevant failure modes and expected outcomes, then write the executable tests before implementing the component or fix. Record why the E2E boundary cannot cover the gap.
7. Run the required verification portfolio and report the evidence and limitations.

For existing code, derive isolated-test scenarios from the public contract before inspecting implementation details. Establish the reproducer before changing production code. When a gap is discovered after implementation, return to independent contract-first design before making further production changes. Mark this as late-discovered evidence in review rather than claiming test-first provenance.

Use deterministic local E2E scenarios for blocking verification when possible. Keep environment-dependent checks explicit and state what the blocking portfolio cannot prove. An existing unchanged capability can reuse established evidence instead of adding a new scenario.

## E2E artifact contract

Each new or changed E2E scenario produces inspectable evidence on success and failure. Discover repository-owned storage and privacy policy before writing artifacts. Keep artifacts outside tracked source files.

Record:

- Scenario and fixture identity, source revision and dirty state, runtime, declared boundary, and substitutions
- One command to repeat the run, prerequisites, and relevant non-secret environment settings
- Expected and actual observations with assertion verdicts and process exit status
- Selected resulting files or other observable products, with hashes for integrity checks
- Bounded, redacted diagnostics with explicit truncation or capture-failure status

Provide a command to verify the saved evidence without rerunning the system under test. Verification checks recorded products against the scenario contract, not only a saved pass flag. Artifact hashes detect changes but are not independent proof of correctness or authenticity.

Capture only necessary fixture-owned data. Use synthetic credentials, omit host secrets and ambient environment dumps, and define retention and cleanup. Preserve partial evidence when a scenario fails and mark missing evidence as incomplete. A repeat run must establish the same behavioral verdict under the declared conditions. Timestamps and temporary paths need not be identical.

The setup configuration pilot is documented in [`docs/setup-e2e.md`](../setup-e2e.md). Existing E2E scenarios adopt this contract when their capability changes. This is not a reason to remove existing coverage first.

## Test classes

Every committed test should have one primary intent:

- **Requirement hardening** — public behavior derived from a documented requirement or tool contract.
- **Regression hardening** — reproduces a known failure and prevents recurrence.
- **Safety invariant** — lifecycle, cancellation, cleanup, process-tree, resource-bound, setup, credential, or portability behavior that must fail safely.
- **Integration** — requires a real process, socket, git repository, analyzer, browser, or language server. This is a cost classification in addition to one of the intents above.
- **E2E** — exercises the declared user or operator entrypoint through the relevant production boundaries. An integration test is not automatically E2E.
- **Catching** — temporary, diff-aware evidence for one implementation. Files named `*.catching.test.ts` are never committed.

Delete or avoid assertions that only mirror source constants, private field layout, function arity, exact prompt prose, incidental rendering details, or lifecycle checks already enforced by build/install verification. A behavior-preserving source change must not require a test change. If a test fails after such a change, treat the test as a removal candidate.

Do not test test wiring. Do not pin package scripts, verification registry arrays, workflow text, dependency versions, generated dependency declarations, dependency waiver snapshots, source import placement, or validator invocation details in tests. Running the canonical validation is the authority for that wiring. Use a static policy check when source structure is a necessary constraint. Test a validation helper only when it owns a durable parsing, exit-status, or fail-safe contract that a successful repository run cannot prove.

## Domain-first evidence

When a boundary parses weak input into a domain value, first establish acceptance and rejection behavior through the E2E workflow. Separate parser and workflow claims only for a named evidence gap.

- Justified isolated parser tests prove that accepted input produces the required refined representation and rejected input produces the expected typed failure. Enumerate failure modes and write these tests before implementing parser changes.
- Workflow tests use parsed domain values. They must not repeat every invalid-input case at downstream layers.
- Add an interaction case when structural decoding and semantic parsing can disagree.
- Treat repeated validation tests across downstream functions as evidence of a missing domain boundary, not as a coverage target.
- Do not expose a validator, constructor, or unsafe factory only for tests. Test through the runtime-owned parsing boundary.

Keep a downstream defensive check only when the domain type cannot practically preserve the invariant or when state can become invalid after parsing. State that reason in the test claim.

## Test maintenance

Each permanent test must justify its maintenance cost with a durable behavioral claim. Delete a test when no requirement, known regression, safety invariant, or cross-boundary interaction explains why a failure matters.

When a test is the only caller of a production export, getter, injection option, return value, or helper, review both items together. Remove the production seam when it has no runtime owner or non-test design purpose. Do not preserve production complexity only to support direct unit inspection.

Before you merge any contribution that adds or changes tests, review each changed test and nearby tests at the same boundary. Remove assertions that restate arrangement data, source structure, or another assertion. Remove existing low-value evidence in the same change. Prefer one E2E scenario over parallel tests of each internal step. Retain narrower tests for named evidence gaps. Migrate one capability at a time: establish E2E evidence, identify residual gaps, then remove tests whose meaningful defects the replacement demonstrably detects. Preserve existing safety and interaction coverage until equivalent evidence exists.

## Test file boundaries

Name Vitest files that require real processes, sockets, Git repositories, or analyzers `*.integration.test.ts` or `*.integration.test.mjs`. Keep pure contract and policy tests in `*.test.ts` or `*.test.mjs` files. Split mixed files when the split improves focused execution without duplicating the fixture or public claim.

- `nub run test:unit` runs the unit files.
- `nub run test:integration` runs the integration files.
- `nub run test` and the standard verification portfolio run both groups.
- `nub run test:safe` runs bounded unit and integration batches in separate one-worker processes. Each process boundary releases module and worker state before the next batch. Integration batches are smaller because these tests use more processes and external resources.
- `nub run test:setup` runs setup safety integration tests in their dedicated shell harness.

Setup tests are permanent when they protect idempotence, portability, managed-file ownership, or preservation of user files. Remove assertions that only mirror script structure or command spelling.

## Composable test portfolios

Keep tests isolated in execution. Do not share mutable fixtures or require an execution order. Compose evidence in the canonical verification portfolio instead.

Each test must own one clear claim and remain meaningful when run alone. A test can use behavior that another test owns as part of its arrangement. Do not repeat the owning assertion unless it gives necessary diagnostic, requirement, interaction, or safety evidence.

First remove checks that do not protect a durable requirement. The incidental checks listed above are examples. To remove evidence because the portfolio subsumes it, all of these conditions must apply:

1. A remaining test establishes the same invariant at the same public boundary.
2. The relevant tests run in the same canonical verification portfolio.
3. Focused execution of each remaining test still has a clear interpretation.
4. Continuing after an unchecked intermediate result cannot hang, leak resources, expose credentials, or cause harmful side effects.
5. The change preserves useful failure location and requirement traceability.
6. Negative-control or red/green evidence shows that the owning test detects the relevant defect.

Do not infer that component dimensions are orthogonal only because the implementation separates them. Before replacing an `N × M` matrix, identify the shared contract. Test every selector or registration path. Keep pairwise or full combinations for representation differences, error translation, state, concurrency, cancellation, cleanup, resource bounds, setup modes, credentials, and other interaction risks.

Use composition to improve the suite as a whole. Do not use test count, assertion count, or speed as sufficient reasons to remove coverage. Analyze `test-duplicates` findings identify review candidates only. Apply the conditions above before pruning a test. `test:changed` remains early feedback and cannot establish portfolio-level composition for merge decisions.

## Independent hardening workflow

Risk-triggered changes require requirement-derived test design that is independent of the implementation session.

1. The implementation owner creates an evidence map. For each requirement or risk, record the owning boundary, existing evidence, missing evidence, and test class.
2. A test-design session starts from the base worktree. It receives the requirement, public contracts, evidence map, and existing tests, but not the implementation diff.
3. The designer fixes E2E scenarios, expected artifacts, and isolated-test exceptions before production implementation begins. For each exception, enumerate failure modes and expected outcomes.
4. The builder writes runnable acceptance scenarios and justified isolated tests before the corresponding production change. An unavailable interface can establish the initial failure, but the completed test must detect behavioral defects rather than only a missing symbol.
5. The implementation session runs this evidence while building. Temporary catching tests remain exploratory evidence, not an exception to the permanent-test design sequence. For a late-discovered gap, return to the independent designer and record the exception before continuing.
6. Regression tests must fail on the base revision and pass on the branch. This red/green result is the counterfactual evidence for an ordinary bug fix.
7. New capabilities use requirement-first evidence plus a practical negative control when one exists. A negative control changes or bypasses the behavior under test and confirms that the test detects the difference.
8. For concurrency, cancellation, cleanup, persistence, resource admission, authority, credential, and security boundaries, a separate adversarial pass proves the highest-risk evidence through a narrow mutation, removed admission check, injected failure, corrupted persisted value, or equivalent counterfactual.
9. Before merge, review the portfolio. Name the unique claim for each new test. Identify existing tests that would fail for the same defect. Remove repeated evidence at the same public boundary.
10. If implementation constraints require an assertion change, return the decision to the independent designer or reviewer.

Keep interaction matrices when representation, error translation, state, concurrency, cancellation, cleanup, persistence, authority, or resource admission differs. Do not repeat a complete pure-policy matrix at every integration layer. Keep one cross-layer case when composition itself can fail.

Scale the artifact, not the rule. A low-risk evidence map can be a few lines in the pull request, and red/green can satisfy the adversarial requirement for an ordinary bug. Use the full separate-pass workflow for changed tool contracts, concurrency, cancellation, cleanup, persistence, resource, setup, settings, credential, security, local-adapter policy, and new slow integration tests. Small internal refactors may rely on existing coverage when no durable behavior changes.

Promoting a generated catching test means independently re-deriving the hardening case. Renaming the generated file is not sufficient.

## Verification portfolios

`scripts/verification-phases.mjs` is the source of truth for canonical verification commands, capability labels, and test classes.

- `nub run verify` runs the standard blocking portfolio.
- `nub run verify:safe` runs the memory-conscious blocking portfolio under the repository-wide heavyweight lock.
- `nub run verify:phase <phase-id>` runs one registered phase for CI or focused diagnosis.
- `nub run test:changed main` is early feedback only. It is not merge authority.
- `nub run test:e2e` remains explicit for hosted or environment-dependent behavior.

Standard Vitest scripts use one supervised Node command. The safe portfolio uses separate supervised batches to bound retained worker state. Tests have no repository wall-clock limit by default. On `SIGINT` or `SIGTERM`, the supervisor terminates the owned process group and escalates after `PI_ENV_TEST_KILL_GRACE_MS`, which defaults to one second. Set `PI_ENV_TEST_TIMEOUT_MS` to a positive millisecond value only when a caller or environment requires a command limit. Vitest continues to use thread workers because fork workers cannot relaunch a Nub-managed Node binary that requires a Nix dynamic-loader wrapper. The standard command caps the pool at four workers to prevent import-heavy test files from oversubscribing the runtime.

The safe and standard portfolios must preserve blocking setup, type, packaging, policy, and runtime checks. Analyze stays outside aggregate verification until strict containment exists. CI may run only the documented bounded Analyze canary.

## Test intent in reviews

For risk-triggered work, the pull request records:

- Test class, declared E2E boundary, and protected capability, regression, or safety invariant
- Artifact location, repeat command, verification command, and retention
- Isolated-test exceptions, their failure-mode inventory, and why E2E evidence is insufficient
- Independent design origin, pre-implementation evidence, and any late-discovered gaps
- Red/green, mutation, or negative-control evidence
- Added, reused, and removed portfolio evidence
- Integration or end-to-end runtime impact
- Omitted coverage and the reason that existing tests are sufficient

CI can reject committed catching tests and enforce executable phases. Independence is review provenance and must not be inferred from file contents.
