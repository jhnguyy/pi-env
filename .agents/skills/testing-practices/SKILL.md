---
name: testing-practices
description: Design verification and select behavioral checks, test doubles, and reproducible evidence. Use before implementation when deciding how to prove a change, and when adding, reviewing, or removing tests.
---

# Testing Practices

Tests are evidence about intended behavior, not a record of how an implementation happens to work. Start with the change's risks and the observation that would distinguish success from a plausible failure. Use the repository's guidance to understand its contracts and available checks.

## Choose the evidence boundary

Workflow tests are valuable when correctness depends on components working together. Focused tests are valuable when they make policy, edge cases, or operational failures cheaper and clearer to exercise. Choose by the question being answered, rather than requiring every feature to follow the same test hierarchy.

Prefer existing coverage and fixtures when they can establish the changed contract. An additional boundary should catch a distinct failure or resolve uncertainty that existing evidence leaves open. A test that repeats an assertion through a different helper does not necessarily increase confidence; a test that catches a broken integration can be useful even when the underlying logic is already covered.

Establish expectations independently of the implementation. For a regression, reproduce the reported failure when practical before changing the code. For new behavior, work through meaningful success and failure cases early enough to influence the design. If readiness, cancellation, or completion is ambiguous, resolve the production contract rather than letting the test invent it.

## Make scenarios informative

Control incidental time, randomness, and external behavior when they obscure the result. Use real conditions when those conditions are the behavior under test. Prefer explicit readiness and completion signals over elapsed-time assumptions; a watchdog limits a stalled test but does not prove the expected outcome occurred.

Keep scenarios independently understandable. Shared setup can reduce expensive initialization, but shared mutable state can conceal ordering dependencies. Parameterization helps when the same scenario has clear input and outcome variations; separate scenarios often explain different workflows better.

Observe results after the relevant boundary has completed. A recorded call proves that a request arrived, not that its result was used. An abort request proves less than the promised termination or external effect. Assertions should make that distinction visible.

## Use realistic collaborators deliberately

Keep inexpensive, deterministic local components real where that helps establish the contract. Substitute external services, credentials, nondeterminism, or hard-to-induce failures at an existing boundary. State what the substitute cannot establish and obtain real-adapter evidence where compatibility or lifecycle behavior depends on it.

Use the framework's lifecycle, scheduling, and test services when they fit. Resource ownership should remain clear through failed startup, cancellation, and teardown failure. A test must not leave work running merely because an assertion failed; cleanup should attempt independent releases and preserve useful failure information.

## Maintain confidence and cost

Review coverage by failure mode before deleting or combining tests. Preserve distinct safety, compatibility, integrity, and expected-failure evidence. Retire assertions for retired requirements, and distinguish temporary diagnostic checks from independently justified regressions. Follow repository rules for retaining those experiments.

Consider startup time, peak resource use, subprocess count, and diagnostic quality when choosing a check. A narrow test with real lifecycle behavior may be more expensive than many pure cases. Measure consequential performance changes rather than treating fewer tests or fewer workers as proof of lower cost.

Leave enough information to reproduce and assess the result: the relevant inputs, expected outcome, actual outcome, and environment constraints. CI logs are often sufficient. Retain artifacts when they expose evidence logs cannot, especially on failure, and follow local privacy and storage policy.
