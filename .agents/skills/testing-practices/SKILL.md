---
name: testing-practices
description: Designs E2E-first tests and repeatable evidence. Use when adding or reviewing tests, fixing a regression, or deciding whether isolated tests are necessary.
---

# Testing Practices

Read the repository testing policy and requirements.

1. **Start with E2E.** Exercise the workflow people use and check its final result. Prefer this as the only behavioral test layer. Reuse existing coverage when it already proves the outcome.
2. **Leave evidence.** Each run produces an inspectable artifact with inputs, expected and actual results, and instructions to reproduce and check it. Preserve failure evidence and follow local privacy and storage policy.
3. **Use isolation only for a named gap.** Explain what E2E cannot exercise reliably. List failure modes and expected outcomes, then write failing tests before the corresponding production code. For existing code, reproduce the failure before changing it. Derive expectations from requirements, not implementation details.
