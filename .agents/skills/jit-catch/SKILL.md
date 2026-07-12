---
name: jit-catch
description: Judgment criteria for promoting catching tests to hardening tests. Use after a passing catching test to decide if it should be committed. The tool description covers mechanics, symlink edge cases, and failure recovery.
---

# Promoting Catching Tests to Hardening

A passing catching test is ephemeral by default (auto-discarded). A permanent hardening test is justified only when it validates either:

1. **Public API requirement** — the test exercises a contract that clients depend on, or
2. **Known regression** — the test prevents a bug we've already encountered and fixed.

Do not promote by renaming `.catching.test.ts` to `.test.ts`. Re-derive the behavioral scenario from the requirement or regression in a separate base-worktree test-design context that has not inspected the implementation diff. A test builder may inspect the branch only after expected behavior is fixed.

For regressions, demonstrate red on the base revision and green on the branch. For a new requirement, record requirement-first scenarios and use a negative control when practical. Follow `docs/conventions/testing.md` for risk triggers and review evidence.

Do NOT promote every passing test. Most serve their purpose once: verify the current diff does not break the extension. After adding independently derived hardening coverage, run `nub run test:unit` from the repo root to confirm the full suite still passes.

If uncertain, leave it as catching. It will auto-discard on the next run, and repository policy rejects committed `*.catching.test.ts` files.
