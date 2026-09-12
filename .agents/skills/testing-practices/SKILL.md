---
name: testing-practices
description: Designs and reviews software tests from public requirements, known regressions, and safety invariants. Use when adding, changing, removing, or reviewing tests, fixing a regression, or selecting test evidence.
---

# Testing Practices

> Tautological tests considered harmful.

1. Read the repository test policy, public contract, and nearby tests.
2. For risk-triggered work, map each risk to its owning boundary and existing or missing evidence. Fix expected scenarios in a separate clean-base session before the builder sees the implementation diff.
3. State one standalone requirement, regression, or safety claim before you write a permanent test. State why a failure matters. Do not add the test if the claim only describes source structure or wiring.
4. Test the claim at the narrowest stable public boundary. A behavior-preserving refactor must not require a test change. Behavior or contract changes can require new expectations.
5. Do not pin source constants, private state, exact prompt prose, registry contents, dependency versions, generated declarations, import placement, or command spelling. Use a static policy check when source structure is the contract.
6. Show red and green for regressions. Use a practical negative control for new requirements.
7. Use a separate adversarial pass for high-risk boundaries identified by the repository policy.
8. Before merge, review every added or changed test and nearby tests at the same boundary. Remove repeated or implementation-coupled evidence when the repository policy permits it. Preserve interaction and safety evidence.
9. Find production exports, getters, return values, injection options, and helpers that only tests use. Remove each seam unless it has a separate runtime or design owner.
10. Use repository-owned commands and verification portfolios.

Do not use test count, assertion count, implementation coverage, or easy mockability as substitutes for durable behavioral evidence. Do not add production seams only to make internal steps directly testable.

Use the `jit-catch` skill before you promote a generated catching test to permanent coverage.
