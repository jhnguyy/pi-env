# Testing conventions

Permanent tests protect capabilities, regressions, or safety invariants. Test count is not a quality target, and moving slow safety coverage out of blocking verification is not a valid speedup.

## Test classes

Every committed test should have one primary intent:

- **Requirement hardening** — public behavior derived from a documented requirement or tool contract.
- **Regression hardening** — reproduces a known failure and prevents recurrence.
- **Safety invariant** — lifecycle, cancellation, cleanup, process-tree, resource-bound, setup, credential, or portability behavior that must fail safely.
- **Integration/e2e** — requires a real process, socket, git repository, analyzer, browser, or language server. This is a cost classification in addition to one of the intents above.
- **Catching** — temporary, diff-aware evidence for one implementation. Files named `*.catching.test.ts` are never committed.

Delete or avoid assertions that only mirror private field layout, function arity, incidental rendering details, or lifecycle checks already enforced by build/install verification.

## Independent hardening workflow

Risk-triggered changes require requirement-derived test design that is independent of the implementation session:

1. The implementation owner records the requirement or regression, public boundary, expected outcomes, and risk. Catching tests may be generated and discarded.
2. A test-design session starts from the base worktree. It receives the requirement, public contracts, and existing tests, but not the implementation diff.
3. The designer fixes behavioral scenarios and expected outcomes before implementation details are available.
4. A test builder may inspect the branch only after those assertions are fixed, to connect public APIs and fixtures.
5. Regression tests must fail on the base revision and pass on the branch. New capabilities use requirement-first evidence plus a negative control when practical.
6. If implementation constraints require changing an assertion, return that decision to the independent designer or reviewer.

This separation is mandatory for changed tool contracts, reproducible bug fixes, concurrency/cancellation/resource/error paths, setup/settings/install/local-adapter policy, and new slow integration tests. Small internal refactors may rely on existing coverage when no durable behavior changes.

Promoting a generated catching test means independently re-deriving the hardening case. Renaming the generated file is not sufficient.

## Verification portfolios

`scripts/verification-phases.mjs` is the source of truth for canonical verification commands, capability labels, and test classes.

- `nub run verify` runs the standard blocking portfolio.
- `nub run verify:safe` runs the memory-conscious blocking portfolio under the repository-wide heavyweight lock.
- `nub run verify:phase <phase-id>` runs one standard phase for CI or focused diagnosis.
- `nub run test:changed main` is early feedback only; it is not merge authority.
- `nub run test:e2e` remains explicit for hosted or environment-dependent behavior.

The safe and standard portfolios must preserve blocking setup, type, packaging, policy, and runtime checks. Analyze stays outside aggregate verification until strict containment exists; CI may run only the documented bounded Analyze canary.

## Test intent in reviews

For risk-triggered work, the pull request records:

- test class and protected capability, regression, or safety invariant;
- independent design origin;
- red/green or negative-control evidence;
- integration/e2e runtime impact;
- omitted coverage and why existing tests are sufficient.

CI can reject committed catching tests and enforce executable phases. Independence is review provenance and must not be inferred from file contents.
