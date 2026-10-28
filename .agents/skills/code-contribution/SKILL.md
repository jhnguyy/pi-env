---
name: code-contribution
description: Deliver atomic repository changes through worktree isolation, implementation, validation, publication, and post-merge cleanup. Use before modifying a repository or performing branch, commit, push, pull-request, merge, or cleanup work.
---

# Code Contribution

## Establish scope and isolate work

- Locate the target repository root and task worktree before repository commands. Ask if the target is ambiguous.
- Read its `README.md`, `CONTRIBUTING.md`, and applicable area instructions. Follow local branch, base synchronization, worktree placement, and initialization requirements.
- Define one verifiable outcome, including required code, tests, migrations, and obsolete-path removal. Record assumptions that can change the solution, risk, or verification. Preserve unrelated behavior and separate independently useful changes.
- Perform repository changes in a dedicated worktree. Inspect Git state before creating or resuming it. Keep the base worktree unchanged on the base branch. Avoid worktrees another session may own.
- Preserve local work. Stop if safe synchronization requires a decision that repository policy does not resolve.

## Inspect and design

Trace the affected workflow through its owner, callers, tests, and dependencies before choosing an implementation.

Before adding a responsibility or moving a boundary, inspect nearby and shared modules and relevant installed dependencies. Compare candidate owners by inputs, outputs, authority, lifecycle, and failure behavior, not names alone. Choose reuse, extension, or a separate owner. Record consequential contract differences for review.

- Choose data structures from access patterns and state transitions. Define types that preserve invariants and prevent invalid call sequences.
- Examine concurrent actors before sharing mutable state. Isolate state when sharing is unnecessary.
- Hide internal sequencing behind narrow interfaces. Keep related workflow operations together and make authority and data flow explicit.
- Separate deterministic transformations from IO, cancellation, resource management, and operational failures.
- Parse untrusted or weakly constrained inputs into domain values before state changes or external effects. Preserve their invariants and required information afterward.
- Bound work before allocation. Prefer one-pass transformations and reuse values derived from immutable inputs.
- Remove obsolete paths and duplicated decisions within scope, but retain checks that enforce current boundary contracts.
- Keep changes removable or reversible. Base performance changes on measured end-to-end behavior.

## Implement and validate

1. Define expected outcomes and failure cases before implementation.
2. Inspect current behavior and select evidence for the complete workflow. Reuse existing E2E coverage. Follow the [testing-practices skill](../testing-practices/SKILL.md) when adding tests.
3. Implement in verifiable phases against those outcomes.
4. Verify the complete workflow and run repository-required checks before review or merge.

## Commit and publish

Inspect `git status` and the diff before committing. Include only intended changes.

Before preparing a pull request, read contribution guidance and applicable templates. Explain the behavioral outcome, rationale, consequential decisions, validation, risks, and follow-up work.

## Clean up after merge

Wait for the user to confirm the merge and request cleanup. Verify the merged pull request or equivalent forge status and confirm that the worktree is clean.

Use the designated closeout tool when available. Otherwise, follow repository base-sync policy, remove only the task worktree, then delete its local branch with `git branch -d`. If squash or rebase history prevents deletion, use `git branch -D` only after the user confirms that the local commits can be discarded.
