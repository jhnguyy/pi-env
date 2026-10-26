---
name: code-contribution
description: "Plans and delivers complete, atomic repository contributions through scope definition, code design, worktree isolation, validation, commits, pull requests, publishing, and cleanup. Use before modifying a repository or performing branch, commit, push, pull-request, merge, or cleanup work."
---

# Code Contribution

Use for repository changes from initial scope through post-merge cleanup.

## Establish the Contribution

- Identify the target repository from the request or ask if it is ambiguous. Find its root and the task worktree before repository commands, even when Pi starts elsewhere. Read the target repository's `README.md` and `CONTRIBUTING.md` when they exist. Follow applicable area-specific instructions.
- State the intended outcome, material assumptions, success criteria, and required validation. Record an assumption when it can change the solution, risk, or result.
- Deliver one coherent outcome with all required code, tests, migrations, and cleanup. Preserve unrelated behavior. Separate work with an independent purpose into another contribution or explicit follow-up.
- Update documentation only for facts that code, tests, or tooling cannot carry.

## Inspect Before Implementing

- Inspect existing owners, callers, nearby tests, and conventions before selecting an implementation.
- Before adding a responsibility or changing a boundary, explore prior art in the affected area, shared modules, and relevant installed dependencies. Find candidate owners and established approaches.
- Compare candidate inputs, outputs, authority, lifecycle, and failure behavior. Establish equivalent contracts from behavior rather than similar names or shapes.
- Choose direct reuse, extension of an existing owner, or a separate owner. Record the considered owners and contract difference when the decision affects review.

## Design the Change

- Make the smallest change that solves the problem. Prefer a small conceptual surface over a small line count. Give each concept one owner and one stable term.
- Choose data structures before writing logic. Trace the main access patterns and state transitions. Define types and ownership so callers can use the capability without special-case coordination.
- Before sharing mutable state, examine how concurrent changes affect each actor. Isolate state when sharing is unnecessary.
- Remove obsolete paths, redundant checks, and duplicated decisions within the contribution’s scope before adding new mechanisms. Preserve checks that enforce current boundary contracts.
- Use narrow interfaces that hide internal sequencing and data. Keep authority and data flow explicit.
- Keep deterministic transforms plain, and put IO, cancellation, resources, and operational failure behind clear boundaries.
- Parse weak or untrusted inputs into invariant-preserving domain values before the workflow causes effects. Preserve established information through downstream operations.
- Bound work before allocation. Prefer simple representations, one-pass data flow, and reuse of values derived from immutable inputs.
- Base structural changes, including new interfaces, services, layers, or helpers, on current ownership, lifecycle, protocol, substitution, workflow, maintenance, or test-leverage needs.
- Keep cohesive workflows together. Prefer designs that make invalid states harder to express and preserve a direct rollback or deletion path.
- Use measured end-to-end behavior as the authority for performance changes.

## Isolate the Work

Perform agentic repository changes in a dedicated worktree. Keep the base worktree unchanged on the base branch.

Follow repository policy for branch names, base synchronization, worktree placement, initialization, and resuming existing work. Before using a branch or worktree, inspect current Git state and avoid any location another session can own. Preserve local work and stop when safe synchronization requires a decision that local policy does not resolve.

## Implement and Validate

- Run focused checks while implementing. Use failures to revise the implementation or its assumptions.
- When repeated fixes fail the same check, evaluate their shared premise before another implementation. Choose a check that could contradict the premise. Use the result to revise the approach.
- Add tests when the outcome, a known regression, or a material risk requires new evidence. Reuse existing coverage when it already proves the required behavior.
- Follow specialized testing practice and repository validation policy. Run the required integration portfolio before review or integration.
- Broaden or repeat checks only when new changes, failures, unresolved concerns, or repository policy justify more evidence.

## Commit and Publish

- Inspect `git status` and the diff before committing. Commit only the intended changes.
- Resolve the push remote from repository instructions or Git configuration. If the remote is ambiguous, ask which remote to use. Set the upstream on the first push.
- Before preparing a pull request, inspect repository contribution guidance and applicable templates. Explain the behavioral outcome, rationale, important decisions, validation, risks, and follow-up work.

## Clean Up

- After merge, verify the merged pull request or equivalent forge status and confirm that the worktree is clean.
- Remove the worktree, then delete the local branch with `git branch -d`. If squash or rebase history prevents deletion, use `git branch -D` only after the user confirms that the local commits can be discarded.
