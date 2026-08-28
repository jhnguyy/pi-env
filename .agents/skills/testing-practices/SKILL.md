---
name: testing-practices
description: Designs and reviews software tests from public requirements, known regressions, and safety invariants. Use when adding, changing, removing, or reviewing tests, fixing a regression, or selecting test evidence.
---

# Testing Practices

> Tautological tests considered harmful.

1. Read the repository test policy, public contract, and nearby tests.
2. State the requirement, regression, or safety invariant that the test protects.
3. Test observable behavior at the narrowest stable public boundary.
4. Do not derive the expected result by repeating the production implementation.
5. Give each permanent test one clear claim that remains meaningful when run alone.
6. For a regression, show that the test fails without the fix and passes with the fix.
7. For a new requirement, use a practical negative control to confirm that the test detects the behavior.
8. Preserve interaction and safety evidence for concurrency, cancellation, cleanup, persistence, authority, credentials, security, and resource bounds.
9. Use repository-owned commands and verification portfolios.

Do not use test count, assertion count, or implementation coverage as substitutes for durable behavioral evidence.

Use the `jit-catch` skill before you promote a generated catching test to permanent coverage.
