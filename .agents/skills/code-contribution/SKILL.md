---
name: code-contribution
description: Deliver atomic repository changes through scope definition, design, worktree isolation, implementation, validation, and publication. Use before modifying a repository or performing branch, commit, push, pull-request, or merge work.
---

# Code Contribution

## Establish the outcome and protect local work

Locate the target repository root and task worktree before running repository commands. If the target is ambiguous, ask before proceeding. Read its `README.md`, `CONTRIBUTING.md`, and applicable area instructions for local branch, base synchronization, worktree placement, and initialization requirements.

Define one verifiable outcome and the benefit it serves, including the required code, tests, migrations, and obsolete-path removal. Identify who depends on the affected behavior and what must remain true for them. Record assumptions that could change the solution, risk, or verification. Keep independently useful changes separate and preserve unrelated behavior.

Perform repository changes in a dedicated worktree, inspecting Git state before you create or resume it. Keep the base worktree unchanged on the base branch, and avoid worktrees another session may own. Preserve local work and stop if safe synchronization requires a decision that repository policy does not resolve.

## Inspect and choose the owner

Trace the affected workflow through its owner, callers, tests, and dependencies before choosing an implementation. Ask which observed condition produces the problem and what evidence would change that explanation. Before adding a responsibility or moving a boundary, inspect nearby and shared modules as well as relevant installed dependencies. Compare candidate owners by inputs, outputs, authority, lifecycle, and failure behavior rather than names alone. Use that comparison to choose reuse, extension, or a separate owner, and record consequential contract differences for review.

## Establish production contracts

Choose data structures from access patterns and state transitions, with types that preserve invariants and prevent invalid call sequences.

For stateful, concurrent, or resource-owning work, establish:

- who owns mutable state and which actors may share it
- who acquires resources and when their release completes
- what readiness, completion, cancellation, and shutdown mean to callers
- which failures callers can handle and where recovery belongs
- which operations may repeat and how partial completion or duplicate execution is handled

Make these decisions in the production design rather than leaving tests or callers to infer them. Isolate state when sharing is unnecessary.

Keep related workflow operations together behind narrow interfaces that hide internal sequencing while making authority and data flow explicit. Separate deterministic transformations from IO, cancellation, resource management, and operational failures. Parse untrusted or weakly constrained inputs into domain values before state changes or external effects, then preserve their invariants and required information.

Bound work before allocation. Prefer one-pass transformations and reuse values derived from immutable inputs. Base performance changes on measured end-to-end behavior. Remove obsolete paths and duplicated decisions within scope while retaining checks that enforce current boundary contracts. Keep changes removable or reversible.

## Implement and validate

1. Define expected outcomes and failure cases before implementation.
2. Inspect current behavior and use the [testing-practices skill](../testing-practices/SKILL.md) to select evidence while the design can still change.
3. Implement in verifiable phases against those outcomes. When results challenge an assumption, investigate the difference and revise the approach; surface changes that affect scope, risk, or commitments.
4. Verify the complete workflow and run repository-required checks before review or merge. State what the results establish and where verification remains limited.

## Commit and publish

Inspect `git status` and the diff before committing so the commit includes only intended changes.

Before preparing a pull request, read contribution guidance and applicable templates. Explain the behavioral outcome and rationale, including consequential decisions, validation, risks, and follow-up work. Make remaining responsibilities explicit: identify their owner and next action, or explain why they are deferred or outside scope. Follow local authorization requirements for publication.
