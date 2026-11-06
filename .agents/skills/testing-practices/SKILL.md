---
name: testing-practices
description: Design functional tests at meaningful responsibility boundaries, select integration evidence, and assess regression coverage. Use before implementation and when adding, reviewing, consolidating, or removing tests.
---

# Testing Practices

A functional test establishes what a unit promises while leaving it free to change how it keeps that promise. Each test should distinguish a plausible contract violation from a correct implementation.

Find the target repository's testing guidance through its `README.md`, `CONTRIBUTING.md`, and applicable agent instructions. Validate configs and templates with native tooling and manual checks.

## Define the promise

Choose a responsibility with independently testable expectations and controllable inputs and collaborators. An internal module can be a useful unit; a functional slice need not cross every deployment boundary.

Derive expected behavior from requirements and caller needs, not the implementation's calculation. Use hand-worked examples or independent references where useful. Include meaningful failure stages, especially when an effect may have occurred before confirmation was lost.

Rely on established collaborator contracts and test the target's own decisions. Select integration evidence when the interaction itself is the promise under examination.

## Design a controlled scenario

Use small, independent, deterministic examples sized to distinguish behavior. Control incidental timing and randomness; observe readiness rather than guessing elapsed time.

Choose real collaborators or doubles for the evidence needed. Preserve the collaborator semantics the target relies on. Reuse established adapter evidence, adding real-adapter qualification when compatibility is consequential or uncertain. Each use of a double need not repeat a real-service test.

Fixtures own resources from allocation, including partial startup. Arrange cleanup as resources are acquired, attempt independent releases, and preserve useful original failures alongside cleanup failures.

Account for total resource cost when choosing execution resources. Small fixtures, serial execution, and unit classification do not establish aggregate memory containment. Qualify scale separately with explicit limits; generated artifacts and dynamic inputs can also escape test selection.

## Observe the promised outcome

Assert contractual outcomes rather than implementation details. A behavior-preserving refactor should leave expectations valid; remove assertions that protect no independent requirement. Treat executable configuration as input and test its effect rather than comparing it with a copied object.

Observe completion at the boundary the claim covers. A recorded request can prove translation, not completion; a cancellation request does not prove shutdown. Check lifecycle outcomes after awaited cleanup or termination.

For an absence that could be vacuous, use a positive control and observe after the operation had its chance to produce the effect. A watchdog bounds a stalled scenario; assertions establish correctness. Name tests for the claims they establish.

## Evolve the suite

Work through meaningful functional slices, establishing a failing expectation first when practical. For regressions, reproduce the failure without the fix when practical. Let each slice inform the next rather than writing speculative batches of tests.

Consolidate coverage by the failures it detects, preserving evidence for current requirements. Replace obsolete fixtures and boundaries rather than continually adding to them. Before removing coverage, establish that retained or replacement evidence detects the same violations, including any real-integration qualification the claim depends on. Retire obsolete requirements explicitly.

Use negative controls or production mutations to resolve consequential uncertainty about detection, not as a ritual for every edit.

Keep temporary diagnostic experiments uncommitted. Retain enough evidence to reproduce consequential results; existing CI output may suffice. Report completed checks and material gaps without exceeding the evidence.
