---
name: testing-practices
description: Design functional tests at meaningful responsibility boundaries, select integration evidence, and assess regression coverage. Use before implementation and when adding, reviewing, consolidating, or removing tests.
---

# Testing Practices

## Discover the project's guidance

Locate the target repository and read its `README.md`, `CONTRIBUTING.md`, applicable agent instructions, and linked testing guidance when present. Discover local conventions from that project rather than resolving repository policy relative to this skill.

## Choose the responsibility to prove

Begin with what the target unit promises: given its inputs and permitted collaborator outcomes, what outputs, state changes, effects, and failures should follow? Resolve unclear readiness, completion, cancellation, or recovery semantics in the production contract before choosing assertions.

Discover useful units through design. An internal function or module can own a legitimate responsibility with independently testable expectations. Choose seams that make inputs, failures, and ownership controllable; public CLI access is not a prerequisite for a unit test.

Rely on established collaborator contracts and focus the target's tests on its own decisions, translations, composition, and failure handling.

Retain targeted integration evidence when compatibility, an interaction, or shared lifecycle behavior is itself the responsibility being tested.

## Derive independent expectations

Derive expected results from requirements and caller needs, using hand-worked examples, invariants, or an independent reference where useful. Each test should distinguish a plausible violation of the target's promise from a correct implementation.

Reject tautological assertions and implementation-locking tests: checks whose expectations merely repeat production configuration, constants, internal structure, or the same calculation used by the implementation. They detect edits rather than broken behavior and turn one design choice into two things to maintain.

Treat configuration as an input to behavior. Prove the routing, permissions, selection, or other outcome it enables instead of asserting that the configuration equals a copied object. Likewise, observe a unit's promised result rather than pinning its private helper sequence when that sequence is not part of the contract.

A behavior-preserving refactor should leave the test valid. When it would require rewriting an expectation, move the assertion to the promised outcome or remove the check if it protects no independent requirement.

Cover meaningful success, input distinctions, and failure stages. Distinguish failures before an effect from failures after it may have occurred when that changes safe retry or recovery.

Assert the complete result required by the contract: returned content, resulting state, relevant effects, and actionable failures. Complete means contractual information, not every incidental representation. A recorded request can prove request translation; it does not by itself prove the requested operation completed.

Name each test for what its assertions actually establish. When an absence claim could be vacuous, use a positive control to show the observation can detect the effect and check after the operation had its chance to produce it.

## Construct controlled scenarios

Use small, deterministic examples that distinguish correct behavior from plausible errors. Size functional fixtures for that purpose, not for the host's available capacity. Select scale and resource qualification separately, with explicit inputs, limits, and claims.

Keep inexpensive, deterministic collaborators real when that makes the test clearer. Use doubles to control relevant inputs, failures, timing, or expensive dependencies. Preserve the collaborator assumptions on which the target depends, including error and lifecycle behavior.

Reuse adequate adapter or contract evidence for those assumptions. Add focused real-adapter evidence when compatibility is consequential or assumptions are uncertain or changed; every use of a double does not require another real-service test.

Keep scenario state independent. Parameterize variations within the same workflow when that clarifies the cases; separate genuinely different workflows.

Control incidental time and randomness. Use real conditions when they are the contract. Coordinate readiness and completion through observable signals rather than elapsed-time guesses. A watchdog bounds a stall; it does not establish success.

## Own resources and execution cost

Fixtures own resources from allocation, including partial startup and setup that cannot return successfully. Arrange cleanup as resources are acquired, attempt independent releases, and preserve useful original failures alongside cleanup failures.

Assert lifecycle outcomes after the promised completion boundary: for example, after awaited shutdown, scope closure, or process termination—not merely after requesting cancellation.

Inspect import, startup, build, child-process, native-allocation, and retained-state costs before choosing execution resources. Small fixtures, serial execution, and unit classification do not establish aggregate memory containment. Account for generated artifacts and dynamic inputs when selecting evidence.

## Preserve useful coverage and evidence

For regressions, reproduce the failure without the fix when practical and retain the meaningful regression case. Where detection is uncertain or consequential, use a relevant negative control or production mutation. Apply these techniques when they add information, rather than requiring a mutation ritual for every trivial edit.

Compare tests by the contract violations they detect, not assertion syntax or test count. Permission, integrity, persistence, cancellation, readiness, completion, and lifecycle may be separate promises despite similar assertions.

When production design or verification strategy changes, revisit the suite as a whole. Replace test boundaries and fixtures that embody obsolete assumptions instead of only adding cases to them.

When consolidating or replacing coverage, preserve independently meaningful contracts and failure cases. Before removing protection for a current requirement, show that retained or replacement evidence detects the same violations. Retire obsolete requirements explicitly.

Keep temporary diagnostic or catching experiments uncommitted. Retain enough information to reproduce consequential evidence; existing CI output may suffice. Report what was checked, its outcome, and material gaps without extending the claim beyond the evidence.
