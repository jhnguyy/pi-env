---
name: testing-practices
description: Designs and reviews software tests from public requirements, known regressions, and safety invariants. Use when adding, changing, removing, or reviewing tests, fixing a regression, or selecting test evidence.
---

# Testing Practices

> Tautological tests considered harmful.

1. Read the repository test policy, public contract, and nearby tests.
2. For risk-triggered work, map each requirement or risk to its owning boundary, existing evidence, missing evidence, and test class before implementation.
3. For risk-triggered work, obtain requirement-derived scenarios from a separate clean-base session. Give it the public contract, evidence map, and existing tests, but not the implementation diff. Fix expected outcomes before the builder sees branch code.
4. State the requirement, regression, or safety invariant that each test protects.
5. Test observable behavior at the narrowest stable public boundary.
6. Do not derive the expected result by repeating the production implementation.
7. Give each permanent test one clear claim that remains meaningful when run alone.
8. For a regression, show that the test fails without the fix and passes with the fix.
9. For a new requirement, use a practical negative control to confirm that the test detects the behavior.
10. For high-risk boundaries, use a separate adversarial pass with a narrow mutation, removed guard, injected failure, or equivalent counterfactual.
11. Before merge, name each new test's unique claim and identify existing tests that detect the same defect. Remove repeated evidence at the same public boundary only when the repository test policy permits removal.
12. Preserve interaction and safety evidence for concurrency, cancellation, cleanup, persistence, authority, credentials, security, and resource bounds.
13. Use repository-owned commands and verification portfolios.

Do not use test count, assertion count, or implementation coverage as substitutes for durable behavioral evidence.

Use the `jit-catch` skill before you promote a generated catching test to permanent coverage.
