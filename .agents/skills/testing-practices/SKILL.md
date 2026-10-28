---
name: testing-practices
description: Design verification and select behavioral checks, test doubles, and reproducible evidence. Use before implementation when deciding how to prove a change, and when adding, reviewing, or removing tests.
---

# Testing Practices

Read the repository's testing policy and requirements before selecting checks. Use this method during design, not only after code exists.

## Define what the evidence must establish

Derive expected outcomes from requirements and supported contracts, not implementation details. Identify the observable result that distinguishes success from failure.

If readiness, completion, cleanup, or cancellation has no defined meaning, resolve the production contract before writing assertions. A test should verify that contract, not invent it.

Distinguish evidence of an intermediate action from evidence of the claimed outcome. A recorded call proves arrival, not that its result was used.

## Select coverage

This skill defaults to E2E-first verification. Exercise the workflow people use and check its final result. Prefer E2E as the only behavioral test layer where it can establish the required contracts reliably. Follow explicit repository requirements.

Reuse existing checks. Add a check only when it detects a contract violation that existing checks cannot detect. Similar outcomes do not make checks redundant. Show that each new check fails when its target contract is violated.

Add isolated tests only for failures that E2E cannot exercise reliably:

1. Identify the E2E coverage gap.
2. List the failure modes and expected outcomes.
3. Write failing tests before the corresponding production code. For existing code, reproduce the failure before changing it.

## Control the scenario

Control incidental time, randomness, and external behavior when they would obscure the result. Use real conditions when those conditions are the behavior under test.

Coordinate concurrent work through explicit readiness or completion signals rather than arbitrary delays. Keep independent scenarios isolated, while deliberately exercising sharing when shared behavior is part of the contract.

Assert lifecycle outcomes after the relevant completion boundary. To establish cleanup, observe release after the owner's lifecycle ends. To establish cancellation, observe the promised termination or external outcome rather than only the request to cancel.

Use the framework's native facilities where they fit. Retrieve library-specific guidance for virtual time, scheduling, resource teardown, and asynchronous completion.

## Choose and verify test doubles

Run local, deterministic components with synthetic data, including binaries, files, parsers, and in-process services.

Reserve doubles for external services, credentials, time, randomness, unavailable platform APIs, or failures that cannot otherwise be induced. Replace dependencies at an existing integration boundary rather than patching internal methods. Prefer injected seams and fakes, and use real implementations for internal collaborators.

For each double, identify a contract test, sandbox run, or recorded response that checks its assumptions about the real dependency. State what the double cannot establish.

Label tests that capture current third-party behavior as change detectors, not requirements.

## Retain current contracts

Delete assertions and fixtures that serve only retired requirements. Keep coverage for current outcomes, compatibility, integrity, and expected failures.

Before removing safety coverage, verify that replacement evidence detects violations of the same contracts. Keep regression tests for current contracts. Leave temporary catching tests uncommitted.

## Leave reproducible evidence

For each run, record inputs, expected and actual results, and instructions to reproduce and check the run. Use CI logs or uploaded artifacts when CI can run the check. Keep local artifacts for checks CI cannot run.

Preserve failure evidence. Follow repository privacy and storage policy.
