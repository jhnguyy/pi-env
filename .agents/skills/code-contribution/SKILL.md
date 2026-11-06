---
name: code-contribution
description: Deliver scoped repository changes with fidelity to user intent, worktree isolation, and verification. Use before modifying a repository or performing branch, commit, push, pull-request, or merge work.
---

# Code Contribution

## Establish scope and isolate work

Locate the target repository root and task worktree before running repository commands. If the target is ambiguous, ask before proceeding. Read its `README.md`, `CONTRIBUTING.md`, and applicable area instructions for local branch, base synchronization, worktree placement, and initialization requirements.

Perform repository changes in a dedicated worktree, inspecting Git state before you create or resume it. Keep the base worktree unchanged on the base branch, and avoid worktrees another session may own. Preserve local work and stop if safe synchronization requires a decision that repository policy does not resolve.

## Stay faithful to the request

Define the requested outcome and the evidence that would establish it. Distinguish user requirements and established contracts from assumptions and optional improvements. An agent's proposal or handoff is not authority to expand scope or introduce new invariants. Ask before making consequential changes to behavior or scope that the request and existing contracts do not settle.

Inspect the affected code, callers, and tests to check the premise and find the existing owner. Use existing capabilities where they fit. Keep independently useful improvements separate; report consequential discoveries rather than silently including them.

## Prefer reduction

Seek the smallest complete solution. Consider deleting an obsolete path, simplifying the current owner, or reusing an existing capability before adding code, abstractions, configuration, or roles. Add machinery only when the requested outcome or an established contract needs it, not for hypothetical future use.

Reduce complexity by consolidating scattered implementation details into cohesive abstractions that cover more of the workflow and require less coordination from callers.

## Implement and verify

Implement the scoped outcome, then review the whole diff for unnecessary additions, unsupported assumptions, and opportunities to simplify. Reconsider the approach when evidence warrants it; a second implementation or separate design stage is not required.

Run repository-required checks and the tests relevant to the affected behavior. Verify the integrated result yourself; a child report is not a substitute. Report completed checks and material gaps without claiming more than the evidence establishes.

## Commit and publish

Inspect `git status` and the diff before committing so the commit includes only intended changes.

Before preparing a pull request, read contribution guidance and applicable templates. Explain the behavioral outcome and rationale, including consequential decisions, validation, risks, and follow-up work.
