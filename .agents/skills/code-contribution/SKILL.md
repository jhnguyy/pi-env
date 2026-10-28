---
name: code-contribution
description: Deliver atomic repository changes through scope definition, design, worktree isolation, implementation, validation, and publication. Use before modifying a repository or performing branch, commit, push, pull-request, or merge work.
---

# Code Contribution

## Establish scope and isolate work

Locate the target repository root and task worktree before running repository commands. If the target is ambiguous, ask before proceeding. Read its `README.md`, `CONTRIBUTING.md`, and applicable area instructions for local branch, base synchronization, worktree placement, and initialization requirements.

Define one verifiable outcome that includes the required code, tests, migrations, and obsolete-path removal. Record assumptions that could change the solution, risk, or verification. Keep independently useful changes separate and preserve unrelated behavior.

Perform repository changes in a dedicated worktree, inspecting Git state before you create or resume it. Keep the base worktree unchanged on the base branch, and avoid worktrees another session may own. Preserve local work and stop if safe synchronization requires a decision that repository policy does not resolve.

## Inspect and design

Trace the affected workflow through its owner, callers, tests, and dependencies before choosing an implementation. Before adding a responsibility or moving a boundary, inspect nearby and shared modules as well as relevant installed dependencies. Compare candidate owners by inputs, outputs, authority, lifecycle, and failure behavior rather than names alone. Use that comparison to choose reuse, extension, or a separate owner, and record consequential contract differences for review.

Choose data structures from access patterns and state transitions, with types that preserve invariants and prevent invalid call sequences. Examine concurrent actors before sharing mutable state, and isolate state when sharing is unnecessary.

Keep related workflow operations together behind narrow interfaces that hide internal sequencing while making authority and data flow explicit. Separate deterministic transformations from IO, cancellation, resource management, and operational failures. Parse untrusted or weakly constrained inputs into domain values before state changes or external effects, then preserve their invariants and required information.

Bound work before allocation. Prefer one-pass transformations and reuse values derived from immutable inputs. Base performance changes on measured end-to-end behavior. Remove obsolete paths and duplicated decisions within scope while retaining checks that enforce current boundary contracts. Keep changes removable or reversible.

## Implement and validate

1. Define expected outcomes and failure cases before implementation.
2. Inspect current behavior and select evidence for the complete workflow. Reuse existing E2E coverage, and follow the [testing-practices skill](../testing-practices/SKILL.md) when adding tests.
3. Implement in verifiable phases against those outcomes.
4. Verify the complete workflow and run repository-required checks before review or merge.

## Commit and publish

Inspect `git status` and the diff before committing so the commit includes only intended changes.

Before preparing a pull request, read contribution guidance and applicable templates. Explain the behavioral outcome and rationale, including consequential decisions, validation, risks, and follow-up work.
