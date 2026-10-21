---
name: dependency-update
description: Reviews and completes dependency updates with justified version choices, useful release highlights, security implications, and compatibility evidence. Use for package upgrades and version comparisons.
---

# Dependency Update

Follow repository policy and package-specific guidance. Use `code-contribution` for repository changes.

A dependency update is complete when:

1. **The version choice is justified.** Establish current locked and installed versions, the selected target, and relevant constraints. Explain meaningful deferrals rather than assuming newest is always best.
2. **The implications are clear.** Use primary sources across the release range to explain useful changes, applicable security fixes, and breaking changes for actual consumers. Link the evidence and state what remains unknown.
3. **The change is coherent.** Keep coupled dependencies, generated locks, and consumer migrations consistent. Preserve unrelated changes. Reassess patches, overrides, and wrappers instead of carrying them forward automatically.
4. **The result is verified.** Exercise affected public workflows and required repository checks against the resulting revision. Retain failure evidence and report unresolved risks, blockers, and remaining actions. A successful install or typecheck alone is not behavioral proof.

Keep the handoff concise. Distinguish a recommendation, a verified repository update, and live activation. Do not call a blocked update complete.
