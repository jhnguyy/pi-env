---
name: code-contribution
description: Deliver scoped repository changes with fidelity to user intent, worktree isolation, and verification. Use before modifying a repository or performing branch, commit, push, pull-request, or merge work.
---

# Code Contribution

## Establish scope and isolate work

Locate the target repository root and task worktree before running repository commands. Read its `README.md`, `CONTRIBUTING.md`, and applicable area instructions for the contribution workflow.

Perform repository changes in a dedicated worktree, inspecting Git state before you create or resume it. Keep the base worktree unchanged on the base branch, and avoid worktrees another session may own. Preserve local work and stop if safe synchronization requires a decision that repository policy does not resolve.

## Understand intent and prior art

Understand the request and the existing solution before choosing an approach. Keep changes focused on the requested outcome.

## Prefer reduction

Prefer simplification over additional machinery. Favor cohesive abstractions that cover more of the workflow with less caller coordination.

## Implement and verify

Implement the requested outcome, then review the whole diff for scope fidelity and simplicity.

Verify immediate changes locally and use CI for broader qualification. Report what was checked locally and what remains for CI.

## Commit and publish

Inspect `git status` and the diff before committing so the commit includes only intended changes.

Prepare pull requests using the repository's contribution guidance and applicable templates.
