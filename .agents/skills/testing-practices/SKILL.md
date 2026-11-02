---
name: testing-practices
description: Design functional tests at meaningful responsibility boundaries, select integration evidence, and assess regression coverage. Use before implementation and when adding, reviewing, consolidating, or removing tests.
---

# Testing Practices

A functional test establishes what a unit promises while leaving it free to change how it keeps that promise. Useful tests distinguish broken behavior from correct alternatives, making the system easier to understand and maintain.

Find the target project's guidance through its `README.md`, `CONTRIBUTING.md`, applicable agent instructions, and linked testing conventions. Discover that guidance in the target repository rather than relative to this skill.

## Define the promise

Discover useful units through design. An internal function or module can own a responsibility with independently testable expectations. Choose seams that make its inputs, collaborator outcomes, and ownership controllable; a functional slice need not enter through the application's public CLI or cross every deployment boundary. Test design can reveal scattered policy, unclear ownership, or lifecycle decisions missing from production. Use that evidence to improve production responsibilities; an abstraction should benefit production callers, not only make collaborators mockable.

Describe what follows from those inputs: outputs, state changes, effects, and failures. Include meaningful input distinctions and failure stages, especially where an effect may have occurred before confirmation was lost. Resolve unclear readiness, completion, cancellation, or recovery semantics in the production contract so the test can establish what callers may safely do next.

Rely on established collaborator contracts and focus on the target's decisions, translations, composition, and failure handling. Select integration evidence when compatibility, an interaction, or shared lifecycle behavior is itself the promise under examination.

## Derive expectations from behavior

Requirements and caller needs supply the expected result. Hand-worked examples, invariants, and independent references can make that expectation concrete without reproducing the implementation's calculation. Each test should distinguish a plausible violation of the promise from a correct implementation.

Reject tautological assertions and implementation-locking tests that merely echo production configuration, constants, internal structure, or calculations. They detect edits rather than broken behavior and turn one design choice into two things to maintain. Treat configuration as an input: prove the routing, permissions, selection, or other outcome it enables instead of comparing it with a copied object. Observe a unit's promised result rather than pinning a private helper sequence that is not part of its contract.

A behavior-preserving refactor should leave the test valid. If it would require rewriting an expectation, move the assertion to the promised outcome or remove the check when it protects no independent requirement.

## Design a controlled scenario

Use small, deterministic examples sized to distinguish behavior, not to match the host's capacity. Keep scenarios independent, parameterizing variations within one workflow when that clarifies them and separating genuinely different workflows. Control incidental time and randomness; use real conditions when those conditions are the contract. Observable readiness and completion signals establish progress more reliably than elapsed-time guesses.

Choose collaborators for the evidence needed. Inexpensive, deterministic implementations can make a scenario clearer; doubles can supply relevant inputs, failures, timing, or expensive dependencies. Preserve the collaborator assumptions the target relies on, including error and lifecycle behavior. Reuse existing adapter or contract evidence, adding real-adapter qualification where compatibility is consequential or assumptions are uncertain or changed. Each use of a double need not repeat a real-service test.

Design the fixture's lifecycle alongside the scenario. It owns resources from allocation, including partial startup that cannot return successfully. Arrange cleanup as resources are acquired, attempt independent releases, and preserve useful original failures alongside cleanup failures.

Account for setup, import, startup, settling, build, child-process, native-allocation, and retained-state costs when choosing execution resources. Select scale and resource qualification separately with explicit inputs, limits, and claims. Small fixtures, serial execution, and unit classification do not establish aggregate memory containment; generated artifacts and dynamic inputs also affect which evidence a change needs.

## Observe the promised outcome

Assert the contractual result: returned content, resulting state, relevant effects, and actionable failures. Completeness means the information the contract covers, not every incidental representation. A recorded request may establish request translation, while completion requires evidence that the requested operation finished. Name the test for the claim its assertions actually establish.

For lifecycle promises, observe the result after awaited shutdown, scope closure, or process termination rather than only after requesting cancellation. For an absence that could be vacuous, use a positive control to establish that the observation can detect the effect and check after the operation had its chance to produce it. A watchdog bounds a stalled scenario; the assertions determine whether the promise was kept.

## Evolve the suite with the design

Work through one meaningful functional slice at a time: establish a failing expectation first when practical, implement sufficient behavior to satisfy the promise, then refactor with that coverage in place. For regressions, reproduce the failure without the fix when practical and retain the meaningful case. Let each slice inform the next rather than writing a broad batch of speculative tests before implementing any behavior.

Compare tests by the contract violations they detect, not by similar assertions or test count. Permission, integrity, persistence, cancellation, readiness, completion, and lifecycle can be distinct promises. When production design or verification strategy changes, revisit the suite as a whole and replace boundaries and fixtures that embody obsolete assumptions rather than only adding cases to them. Replacement is an evidence decision, not an automatic deletion rule: before removing protection for a current requirement, show that retained or replacement evidence detects the same violations, including any real-integration qualification on which the claim depends. Retire obsolete requirements explicitly.

Use negative controls or relevant production mutations when they resolve consequential uncertainty about detection, rather than as a ritual for every trivial edit.

Keep temporary diagnostic or catching experiments uncommitted. Retain enough evidence to reproduce consequential results; existing CI output may suffice. Report what was checked, the outcome, and material gaps so the claim stays within the evidence.
