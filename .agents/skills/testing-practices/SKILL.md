---
name: testing-practices
description: Designs and reviews E2E-first evidence from public requirements, known regressions, and safety invariants. Use when adding, changing, removing, or reviewing tests, fixing a regression, or selecting test evidence.
---

# Testing Practices

## Select the evidence before implementation

1. Read the repository test policy, public contract, and existing evidence. Discover local artifact storage, privacy, and verification requirements.
2. State the observable user or operator outcome, exact inputs, expected results, and material failure cases.
3. Prefer an E2E scenario as the sole behavioral evidence when it covers the claim and risks. Enter through the real supported interface. Name the production boundaries exercised and any substitutions or omitted behavior.
4. For risk-triggered work, fix scenarios and expected outcomes in a separate clean-base session before production implementation. Follow the repository's independence requirements.
5. Reuse an existing scenario or write runnable acceptance evidence before the production change. Establish a failing baseline where practical.
6. Name residual evidence gaps. For each necessary isolated test, explain why E2E evidence cannot safely or reliably cover the claim. Enumerate relevant failure modes and expected outcomes, then write the tests before implementing the component or fix.

For existing code, derive scenarios from the public contract before inspecting implementation details. Write the reproducer before changing production code. For a gap found after implementation, return to independent contract-first design before further production changes and record the late-discovered evidence honestly.

## Implement and verify

1. Implement the behavior and run the selected scenarios.
2. Produce bounded, privacy-safe artifacts on success and failure: source and fixture identity, runtime, repeat command, expected and actual observations, and selected observable products. Follow repository retention policy.
3. Verify saved products against the scenario contract with a repeatable command. A saved pass flag or an agent summary is not sufficient evidence. Mark missing or truncated evidence explicitly.
4. Show red and green for regressions. Use a practical negative control for new requirements and a separate adversarial pass where repository policy requires it.
5. Keep type, static policy, packaging, and install checks. Run repository-owned verification portfolios before integration.

## Maintain the portfolio

Migrate one capability at a time: establish E2E evidence, identify residual gaps, retain justified isolated tests, then remove demonstrably redundant evidence. Preserve safety and interaction coverage until replacements detect the same meaningful defects.

A permanent test must protect a requirement, known regression, or safety invariant. Test observable behavior rather than source constants, private state, exact prompt prose, registries, versions, import placement, or command spelling. A behavior-preserving refactor must not require expectation changes.

For weak input, establish acceptance and rejection at the E2E boundary first. Add isolated parser cases for named gaps. Use parsed domain values downstream instead of repeating invalid-input matrices at every layer.

Review test-only production seams with their tests. Keep a seam only when it has a runtime or independent design owner. Use static policy checks when source structure is the necessary contract.

Temporary catching tests remain exploratory. Use the `jit-catch` skill before independently re-deriving any permanent evidence from them. Test count, implementation coverage, speed, and easy mockability are not substitutes for durable behavioral claims.
