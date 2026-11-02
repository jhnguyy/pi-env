---
name: code-contribution
description: Deliver atomic repository changes through separate design and implementation agents, worktree isolation, integrated verification, and publication. Use before modifying a repository or performing branch, commit, push, pull-request, or merge work.
---

# Code Contribution

## Establish scope and isolate work

Locate the target repository root and task worktree before running repository commands. If the target is ambiguous, ask before proceeding. Read its `README.md`, `CONTRIBUTING.md`, and applicable area instructions for local branch, base synchronization, worktree placement, and initialization requirements.

Define one verifiable outcome that includes the required code, tests, migrations, and obsolete-path removal. Record assumptions that could change the solution, risk, or verification. Keep independently useful changes separate and preserve unrelated behavior.

Perform repository changes in a dedicated worktree, inspecting Git state before you create or resume it. Keep the base worktree unchanged on the base branch, and avoid worktrees another session may own. Preserve local work and stop if safe synchronization requires a decision that repository policy does not resolve.

## Separate design from implementation

Code changes require a design agent and a different implementation agent. This includes tests, build logic, and configuration that controls behavior, regardless of file extension. Simple documentation-only edits may remain single-agent; mixed changes follow the code workflow. The coordinator owns scope, sequencing, design acceptance, integration, and final verification. Use the [orchestration skill](../orchestration/SKILL.md) for delegation mechanics.

The designer investigates existing owners, callers, and contracts and applies the [planning](../planning/SKILL.md) and [testing-practices](../testing-practices/SKILL.md) skills to produce an evidence-grounded design, not production code. Use the ownership and production-contract guidance below to shape the design.

For structural changes, the designer also consults the [refactor skill](../refactor/SKILL.md) to assess opportunities, ownership, and preservation evidence.

Keep the handoff proportional to the change, covering:

- the intended outcome, scope, and invariants
- inspected evidence and what it establishes
- the chosen owner and approach, alternatives, and consequential tradeoffs
- affected contracts, implementation phases, and proposed verification
- assumptions, unknowns, and risks, with how and when to resolve them

A small change can use a brief handoff; create a design document only when the decisions warrant one. Distinguish proposed checks from completed evidence. The coordinator resolves or escalates consequential ambiguities before dependent implementation and dispatches the separate implementer only after accepting the handoff. Resolve routine design details within the task's existing authorization.

## Inspect and choose the owner

Trace the affected workflow through its owner, callers, tests, and dependencies before choosing an implementation. Before adding a responsibility or moving a boundary, inspect nearby and shared modules as well as relevant installed dependencies. Compare candidate owners by inputs, outputs, authority, lifecycle, and failure behavior rather than names alone. Use that comparison to choose reuse, extension, or a separate owner, and record consequential contract differences for review.

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

1. The coordinator gives the separate implementer the accepted design handoff, supporting evidence, and work boundaries.
2. The implementer validates the handoff against current code and discovers and applies applicable skills and repository practices. Challenge assumptions when the evidence warrants it. Return consequential deviations in scope, ownership, contracts, or verification to the coordinator before affected work proceeds; inexpensive, reversible implementation details remain at the implementer's discretion.
3. Implement every change in two sequential passes, not parallel versions. First establish the outcome and learn its constraints; then reconsider the whole solution as if those constraints had been known from the start. Revise ownership, interfaces, code, and tests together rather than preserve the first structure and layer additions. Scale both passes proportionately; documentation-only changes need drafting and reconsideration of the whole explanation and placement. Make warranted replacements without forcing churn or line-count reductions; explain reasoned retention. Return changes, both passes' findings, verification evidence, design departures, and remaining gaps.
4. The coordinator reviews the integrated diff and verifies the combined result against the accepted outcomes and affected contracts, including repository-required checks, before review or merge. Child reports do not substitute for coordinator verification.

## Commit and publish

Inspect `git status` and the diff before committing so the commit includes only intended changes.

Before preparing a pull request, read contribution guidance and applicable templates. Explain the behavioral outcome and rationale, including consequential decisions, validation, risks, and follow-up work.
