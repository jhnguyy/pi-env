---
name: testing-practices
description: Selects behavioral checks, test doubles, and reproducible evidence without duplicate coverage. Use when adding or reviewing tests, fixing regressions, or removing coverage.
---

# Testing Practices

Read the repository's testing policy and requirements before selecting checks.

## Start with E2E coverage

Derive expected outcomes from requirements, not implementation details. Exercise the workflow people use and check its final result. Prefer E2E as the only behavioral test layer.

Reuse existing checks. Add a check only when it detects a contract violation that existing checks cannot detect. Similar outcomes do not make checks redundant. Show that each new check fails when its target contract is violated.

Add isolated tests only for failures that E2E cannot exercise reliably:

1. Identify the E2E coverage gap.
2. List the failure modes and expected outcomes.
3. Write failing tests before the corresponding production code. For existing code, reproduce the failure before changing it.

## Choose and verify test doubles

Run local, deterministic components with synthetic data, including binaries, files, parsers, and in-process services.

Use test doubles only for external services, credentials, time, randomness, platform APIs the runtime lacks, or failures that cannot otherwise be induced. Replace dependencies at the outermost boundary, not at internal methods. Prefer injected seams and fakes over patching modules. Inject real implementations for internal collaborators.

Assert observable results. Recording what crosses the boundary is fine, but a recorded call proves arrival, not that the result was used.

For each double, identify a contract test, sandbox run, or recorded response that checks its assumptions about the real dependency. Label tests that capture current third-party behavior as change detectors, not requirements.

## Retain current contracts

Delete assertions and fixtures that serve only retired requirements. Keep coverage for current outcomes, compatibility, integrity, and expected failures.

Before removing safety coverage, verify that replacement evidence detects violations of the same contracts. Keep regression tests for current contracts. Leave temporary catching tests uncommitted.

## Leave reproducible evidence

For each run, record inputs, expected and actual results, and instructions to reproduce and check the run. Use CI logs or uploaded artifacts when CI can run the check. Keep local artifacts for checks CI cannot run.

Preserve failure evidence. Follow repository privacy and storage policy.
