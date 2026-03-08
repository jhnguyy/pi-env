---
name: jit-catch
description: Judgment criteria for promoting catching tests to hardening tests. Use after a passing catching test to decide if it should be committed. The tool description covers mechanics, symlink edge cases, and failure recovery.
---

# Promoting Catching Tests to Hardening

A passing catching test is ephemeral by default (auto-discarded). Promote it to hardening
(rename `.catching.test.ts` → `.test.ts`) only if the test validates either:

1. **Public API requirement** — the test exercises a contract that clients depend on, or
2. **Known regression** — the test prevents a bug we've already encountered and fixed

Do NOT promote every passing test. Most serve their purpose once: verify the current diff
doesn't break the extension. After promotion, run `bun test` in the extension directory
to confirm the full suite still passes.

If uncertain, leave it as catching. It will auto-discard on the next run.
