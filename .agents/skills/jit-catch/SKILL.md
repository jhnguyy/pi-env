---
name: jit-catch
description: Judgment criteria for promoting catching tests to hardening tests. Use after a passing catching test to decide if it should be committed. The tool description covers mechanics, symlink edge cases, and failure recovery.
---

# Promoting Catching Tests to Hardening

Use `testing-practices` for general test design. Use this skill only after a generated catching test passes and promotion is under consideration.

A passing catching test is ephemeral by default (auto-discarded). A permanent hardening test is justified only when it validates one of these durable claims:

- **Public API requirement** — the test exercises a contract that clients depend on.
- **Known regression** — the test prevents a bug we've already encountered and fixed.
- **Safety invariant** — the test protects required failure, cleanup, lifecycle, resource, credential, or portability behavior.

Do not promote by renaming `.catching.test.ts` to `.test.ts`. Re-derive the behavioral scenario from the requirement, regression, or safety invariant in a separate base-worktree test-design context that has not inspected the implementation diff. A test builder may inspect the branch only after expected behavior is fixed.

For regressions, demonstrate red on the base revision and green on the branch. For a new requirement, record requirement-first scenarios and use a negative control when practical. For a safety invariant, use the adversarial evidence required by repository policy. Follow `docs/conventions/testing.md` for risk triggers and review evidence.

Do not promote every passing test. Most serve their purpose once: verify that the current diff does not break the extension. After adding independently derived hardening coverage, run the verification required by repository policy.

If uncertain, leave it as catching. It will auto-discard on the next run, and repository policy rejects committed `*.catching.test.ts` files.
