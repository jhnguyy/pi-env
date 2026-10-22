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

Use `*.integration.test.ts` or `*.integration.test.mjs` for workflows that require real process or storage lifecycles. [`vitest.config.ts`](../../vitest.config.ts) separates these from the unit portfolio. Unit tests have a five-second budget. Integration and E2E workflows have a thirty-second budget, including when the default test command runs both portfolios. Keep readiness and completion event-driven. Use explicit tighter watchdogs when the scenario needs them, and distinguish watchdog activation from the expected outcome.

Standalone Vitest runs, typechecks, and type-aware lint share the `verify:safe` heavyweight lock across sibling Git worktrees. Nested commands inherit the owning lease. A waiting command reports the owner and waits up to ten minutes. Set `PI_ENV_HEAVYWEIGHT_LOCK_TIMEOUT_MS=0` to fail immediately on contention. Non-Git source snapshots run without worktree coordination. This lock does not coordinate unrelated repositories or bound memory within one command. Use `test:safe` for a one-worker test portfolio on constrained hosts.

E2E-first does not replace type, static policy, packaging, or install checks. Use [the canonical verification portfolio](../../scripts/verification-phases.mjs) and follow [the contribution requirements](../../CONTRIBUTING.md).
