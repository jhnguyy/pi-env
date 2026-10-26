---
name: code-contribution
description: "Plans and delivers complete, atomic repository contributions through scope definition, code design, worktree isolation, validation, commits, pull requests, publishing, and cleanup. Use before modifying a repository or performing branch, commit, push, pull-request, merge, or cleanup work."
---

# Code Contribution

Use for repository changes from initial scope through post-merge cleanup.

## Establish the Contribution

- Identify the target repository from the request or ask if it is ambiguous. Find its root and the task worktree before repository commands, even when Pi starts elsewhere. Read the target repository's `README.md` and `CONTRIBUTING.md` when they exist. Follow applicable area-specific instructions.
- State the intended outcome, material assumptions, success criteria, and required validation. Record an assumption when it can change the solution, risk, or result.
- Deliver one coherent outcome in verifiable phases, including the required code, tests, migrations, and cleanup. Preserve unrelated behavior. Separate work with an independent purpose into another contribution or explicit follow-up.
- Update documentation only for facts that code, tests, or tooling cannot carry.

## Inspect Before Implementing

- Identify the module, service, or dependency responsible for the intended result. Inspect its callers, nearby tests, and conventions before selecting an implementation.
- Before adding a responsibility or changing a boundary, explore prior art around the affected area, in shared modules, and in relevant installed dependencies.
- Compare candidate inputs, outputs, authority, lifecycle, and failure behavior. Establish equivalent contracts from behavior rather than similar names or shapes.
- Choose direct reuse, extension of an existing owner, or a separate owner. Record the considered owners and contract difference when the decision affects review.

## Design the Change

- Make the smallest change that solves the problem. Prefer fewer concepts over fewer lines. Give each concept one owner and one stable term.
- Choose data structures before writing logic. Trace the main access patterns and state transitions. Define types and ownership so callers can use the capability without special-case coordination.
- Before sharing mutable state, examine how concurrent changes affect each actor. Isolate state when sharing is unnecessary.
- Remove obsolete paths, redundant checks, and duplicated decisions within the contribution’s scope before adding new mechanisms. Preserve checks that enforce current boundary contracts.
- Use narrow interfaces that hide internal sequencing and data. Keep authority and data flow explicit.
- Keep deterministic data transformations simple. Put IO, cancellation, resource management, and operational failures behind explicit boundaries.
- Parse weakly constrained or untrusted inputs into domain values that preserve required invariants before using them to change state or cause external effects. Preserve established invariants and information through later operations.
- Bound work before allocation. Prefer simple representations, one-pass data flow, and reuse of values derived from immutable inputs.
- Keep each workflow’s related operations together. Prefer designs that make invalid states harder to express. Keep changes easy to roll back or remove.
- Use measured end-to-end behavior as the authority for performance changes.

## Isolate the Work

Perform agentic repository changes in a dedicated worktree. Keep the base worktree unchanged on the base branch.

Follow repository policy for branch names, base synchronization, worktree placement, initialization, and resuming existing work. Before using a branch or worktree, inspect current Git state and avoid any location another session can own. Preserve local work and stop when safe synchronization requires a decision that local policy does not resolve.

## Implement and Validate

Work in phases:

1. Define expected outcomes and failure cases from requirements before writing implementation code.
2. Explore the affected workflow and its current behavior. Identify how to verify the intended result. Reuse existing E2E coverage where possible. Follow the [testing-practices skill](../testing-practices/SKILL.md) when new tests are needed.
3. Implement the change against those expected outcomes.
4. Verify the complete workflow and run the required repository checks before review or merge.

## Commit and Publish

- Inspect `git status` and the diff before committing. Commit only the intended changes.
- Before preparing a pull request, inspect repository contribution guidance and applicable templates. Explain the behavioral outcome, rationale, important decisions, validation, risks, and follow-up work.

## Clean Up

- After merge, verify the merged pull request or equivalent forge status and confirm that the worktree is clean.
- Remove the worktree, then delete the local branch with `git branch -d`. If squash or rebase history prevents deletion, use `git branch -D` only after the user confirms that the local commits can be discarded.
