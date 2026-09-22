# Testing conventions

1. **Prefer E2E tests as the sole behavioral test layer.** Verify complex features through the workflow people use and check the final result. Add isolated tests only for failures that E2E cannot exercise reliably.
2. **Finish with verifiable, repeatable evidence.** Each E2E run leaves an artifact with its inputs, expected result, actual result, and instructions to reproduce and check it. Preserve useful evidence on failure. Exclude secrets.
3. **Write isolated tests before production code.** First explain the E2E gap. List the component's failure modes and expected outcomes, then write failing tests before implementing it. For existing code, reproduce the failure before changing it. Derive expectations from requirements, not from the implementation you just wrote.

Keep existing safety coverage until replacement evidence detects the same failures. Temporary catching tests remain uncommitted.

E2E-first does not replace type, static policy, packaging, or install checks. Use [the canonical verification portfolio](../../scripts/verification-phases.mjs) and follow [the contribution requirements](../../CONTRIBUTING.md).
