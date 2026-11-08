---
name: testing-practices
description: Design functional tests at meaningful responsibility boundaries, select integration evidence, and assess regression coverage. Use before implementation and when adding, reviewing, consolidating, or removing tests.
---

# Testing Practices

Prioritize tests that detect meaningful behavioral failures, not tests that merely confirm an edit. Check static wording by inspection. Behavioral tests should survive behavior-preserving refactors.

Find testing guidance in the target repository. Validate configs and templates with native tooling and manual checks.

## Choose what to test

State the expected behavior before choosing assertions. Derive it from requirements and caller needs, not by copying the implementation's calculation. Hand-worked examples or independent references can supply expected results.

Choose a responsibility whose inputs and results you can observe. An internal module can be a useful unit; tests need not enter through the application's public interface. Test the unit's own decisions, relying on established behavior of its dependencies. Use integration tests when the interaction itself needs verification.

Include failure cases that change what callers may safely do next. For example, losing confirmation after an external effect is different from failing before that effect occurred.

## Build the scenario

- Keep examples small and independent. Control incidental timing and randomness; wait for readiness signals rather than guessing delays.
- Choose real dependencies or test doubles for the evidence needed. A double must preserve the dependency behavior the tested code relies on. Reuse existing real-dependency evidence unless that behavior changed or remains uncertain.
- Arrange cleanup as fixtures acquire resources, including during partial startup. Attempt independent releases even if one fails, preserving the original failure alongside cleanup errors.
- Account for the whole scenario's resource use. Small tests and serial execution do not by themselves bound aggregate memory use. Check scale separately with explicit limits. Generated artifacts and dynamic inputs may escape automatic test selection.

## Check the result

Assert the result callers rely on. Treat executable configuration as input and test its effect rather than comparing it with a copied object. Name each test for the behavior its assertions establish.

Wait for the outcome being claimed. Recording a request proves it was sent, not completed. Requesting cancellation does not prove shutdown; wait for cleanup or termination before checking its effects.

When asserting that something did not happen, first establish that the observation can detect it, then check after the operation had its chance to produce the effect. A timeout prevents a stalled test from hanging; it does not prove correct behavior.

## Maintain useful coverage

Work through one meaningful behavior at a time. Establish a failing expectation before implementation when practical; for a regression, reproduce the failure without the fix. Let the result inform the next test rather than writing speculative batches.

Start from existing coverage and consider rewriting, consolidation, and removal before addition. Assign each behavioral promise an authoritative test boundary. Consumers should test their own decisions, relying on established dependency contracts rather than repeating their tests. Add another test only when it detects a distinct failure that retained coverage cannot detect.

Before removing protection for a current requirement, establish that retained tests detect the same failures, including any real-dependency checks the claim relies on. Remove assertions that protect no requirement and retire obsolete requirements explicitly.

Deliberately break the relevant behavior when that would resolve consequential uncertainty about whether a test detects failure. Do not require this for every edit.

Keep temporary diagnostic experiments uncommitted. Retain enough evidence to reproduce consequential results; CI output may suffice. Report what passed and what remains unverified.
