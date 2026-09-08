---
name: testing-practices
description: Designs and reviews software tests from public requirements, known regressions, and safety invariants. Use when adding, changing, removing, or reviewing tests, fixing a regression, or selecting test evidence.
---

# Testing Practices

> Tautological tests considered harmful.

1. Read the repository test policy, public contract, and nearby tests.
2. For risk-triggered work, map each risk to its owning boundary and existing or missing evidence. Fix expected scenarios in a separate clean-base session before the builder sees the implementation diff.
3. Give each permanent test one standalone requirement, regression, or safety claim at the narrowest stable public boundary. Do not mirror the implementation.
4. Show red and green for regressions. Use a practical negative control for new requirements.
5. Use a separate adversarial pass for high-risk boundaries identified by the repository policy.
6. Before merge, remove repeated evidence only when the repository policy permits it. Preserve interaction and safety evidence.
7. Use repository-owned commands and verification portfolios.

Do not use test count, assertion count, or implementation coverage as substitutes for durable behavioral evidence.

Use the `jit-catch` skill before you promote a generated catching test to permanent coverage.
