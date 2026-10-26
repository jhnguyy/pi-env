---
name: testing-practices
description: Selects tests and reproducible evidence without duplicate coverage. Use when adding or reviewing tests, fixing regressions, choosing test doubles, or removing tests.
---

# Testing Practices

Read the repository testing policy and requirements.

## Select checks

Derive expected outcomes from requirements, not implementation details. Exercise the workflow people use and check its final result. Prefer E2E as the only behavioral test layer.

Reuse existing checks. Add a check only when it detects a contract violation that existing checks cannot detect. Similar outcomes do not make checks redundant.

Add isolated tests only for failures that E2E cannot exercise reliably. Identify that gap, list the failure modes and expected outcomes, and write failing tests before the corresponding production code. For existing code, reproduce the failure before changing it.

## Use real components

Run local, deterministic components with synthetic data, including binaries, files, parsers, and in-process services.

Use test doubles only for external services, credentials, time, randomness, or failures that cannot otherwise be induced. Replace dependencies at the outermost boundary, not at internal methods. Assert observable results and data crossing that boundary, not calls recorded by a double.

Identify a contract test, sandbox run, or recorded response that checks each double's assumptions about the real dependency. Label tests that capture current third-party behavior as change detectors, not requirements.

## Retain useful coverage

Delete assertions and fixtures that serve only retired requirements. Keep coverage for current outcomes, compatibility, integrity, and expected failures.

Before removing safety coverage, verify that replacement evidence detects violations of the same contracts. Keep regression tests for current contracts. Leave temporary catching tests uncommitted.

## Leave reproducible evidence

Record inputs, expected and actual results, and instructions to reproduce and check each run. Use CI logs or uploaded artifacts when CI can run the check. Keep local artifacts for checks CI cannot run.

Preserve failure evidence. Follow repository privacy and storage policy.
