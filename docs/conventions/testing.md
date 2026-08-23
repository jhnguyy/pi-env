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
3. The designer fixes behavioral scenarios and expected outcomes before implementation details are available.
4. The implementation session can create and discard catching tests. It must not promote each internal branch to permanent evidence.
5. A test builder may inspect the branch only after the scenarios are fixed. The builder connects assertions to public APIs and fixtures.
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
- `nub run verify:phase <phase-id>` runs one standard phase for CI or focused diagnosis.
- `nub run test:changed main` is early feedback only. It is not merge authority.
- `nub run test:e2e` remains explicit for hosted or environment-dependent behavior.

The safe and standard portfolios must preserve blocking setup, type, packaging, policy, and runtime checks. Analyze stays outside aggregate verification until strict containment exists. CI may run only the documented bounded Analyze canary.

## Test intent in reviews

For risk-triggered work, the pull request records:

- Test class and protected capability, regression, or safety invariant
- Independent design origin
- Red/green, mutation, or negative-control evidence
- Added, reused, and removed portfolio evidence
- Integration or end-to-end runtime impact
- Omitted coverage and the reason that existing tests are sufficient

CI can reject committed catching tests and enforce executable phases. Independence is review provenance and must not be inferred from file contents.
