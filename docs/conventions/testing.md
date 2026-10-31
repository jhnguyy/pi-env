# Testing conventions

1. **Prefer E2E tests as the sole behavioral test layer.** Verify complex features through the workflow people use and check the final result. Add isolated tests only for failures that E2E cannot exercise reliably.
2. **Finish with verifiable, repeatable evidence.** Each E2E run leaves an artifact with its inputs, expected result, actual result, and instructions to reproduce and check it. When CI runs the check, the CI log or uploaded artifact is the reference location. Preserve useful evidence on failure. Exclude secrets.
3. **Write isolated tests before production code.** First explain the E2E gap. List the component's failure modes and expected outcomes, then write failing tests before implementing it. For existing code, reproduce the failure before changing it. Derive expectations from requirements, not from the implementation you just wrote.

Follow the [`testing-practices` skill](../../.agents/skills/testing-practices/SKILL.md) for test doubles and for test retention and removal, including safety coverage and temporary catching tests. For TypeScript workflows that use Effect, follow [Effect guardrails](effect-guardrails.md#tests) for test execution, time, layers, and cleanup.

## Test structure and review

E2E-first selects the workflow boundary. It does not require one large test. Split independent outcomes into named scenarios with shared setup where appropriate. Scenarios must not depend on the order of earlier assertions or responses.

Use parameterized cases when each row keeps setup and expected outcomes explicit. Split cases when parameters select different setup workflows or expectation logic.

Use a subprocess when the contract or isolation requires a separate process. Keep its launcher thin. Put substantial test programs in normal, type-checked source files rather than command strings. Reuse fixtures for a common lifecycle, not to build a general test framework.

Assert observable results at the chosen boundary. For model-facing tools, check the content the model receives. Metadata or a truncation notice alone does not prove that useful output survives. Keep test names consistent with what assertions establish. Distinguish compile-time restrictions from runtime behavior.

Use unique temporary directories and register cleanup immediately. When the test runner owns teardown, separate allocation from asynchronous startup. Keep allocation failure-safe. Assign the fixture before starting it so registered teardown owns resources after failed startup or restart attempts.

Attempt every cleanup step even when an earlier step fails. Preserve operation failures and all cleanup failures instead of replacing them.

Tests with explicit inputs must not depend on personal settings unless settings integration is the contract under test.

Give each behavior one owning workflow. Extend that workflow instead of repeating its setup and assertions in a feature-specific test. Check idempotency by rerunning an operation and comparing persisted state, not by testing each implementation step.

Share fixture lifecycle and evidence handling when multiple workflows need the same contract. Name each fixture for the resources or responsibility it owns. Keep scenario actions and expected outcomes explicit.

Use `*.integration.test.ts` or `*.integration.test.mjs` for workflows that require real process or storage lifecycles. [`vitest.config.ts`](../../vitest.config.ts) owns project selection and timeout defaults. Keep readiness and completion event-driven. Use explicit tighter watchdogs when the scenario needs them, and distinguish watchdog activation from the expected outcome.

E2E-first does not replace type, static policy, packaging, or install checks. Use [the change-scoped and full verification plans](../../scripts/verification-phases.mjs) and follow [the contribution requirements](../../CONTRIBUTING.md).

Local verification checks complete changed files, not just edited lines. Select tests through the owning component and Vitest's import graph; do not create a second dependency graph. An empty delta selects no checks. No automatic local phase may substitute a whole-repository scan when its delta is empty or unavailable. Full verification is an explicit CI/manual operation, including for source snapshots without Git metadata.

Run verification phases sequentially and finish process cleanup before advancing. Use Vitest's isolated fork lifecycle rather than a second batching runner. Worker count is not a memory limit: tests that launch subprocesses must own their full lifecycle, including failed startup, cancellation, and teardown failure. Treat subprocess count and peak memory as properties of the scenario, not of its file suffix.

Review expensive coverage by contract, not by matching test names. Consolidate only when the replacement workflow detects the same failure modes, including denied access, stale state, partial failure, cancellation, and cleanup. Preserve those assertions while moving shared setup to its existing lifecycle owner.
