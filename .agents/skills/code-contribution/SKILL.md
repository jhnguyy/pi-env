---
name: code-contribution
description: "Plans and delivers complete, atomic repository contributions through scope definition, code design, worktree isolation, validation, commits, pull requests, publishing, and cleanup. Use before modifying a repository or performing branch, commit, push, pull-request, merge, or cleanup work."
---

# Code Contribution

Use for repository changes from initial scope through post-merge cleanup.

## Establish the Contribution

- Read the repository instructions before changing files. Read `README.md` and `CONTRIBUTING.md` when they exist. Follow applicable area-specific instructions.
- State the intended outcome, material assumptions, success criteria, and required validation. Record an assumption when it can change the solution, risk, or result.
- Deliver one coherent outcome completely. Include all code, tests, documentation, migrations, and cleanup required for that outcome. Preserve unrelated behavior. Every changed part must support the pull request intention.
- Separate work that has an independent purpose into another contribution or explicit follow-up.

## Inspect Before Implementing

- Inspect existing owners, callers, nearby tests, and conventions before selecting an implementation.
- Before adding a responsibility or changing a boundary, find candidate owners in the affected area, shared modules, and relevant installed dependencies.
- Compare candidate inputs, outputs, authority, lifecycle, and failure behavior. Similar names or shapes do not establish equivalent contracts.
- Choose direct reuse, extension of an existing owner, or a separate owner. Record the considered owners and contract difference when the decision affects review.

## Design the Change

- Prefer a small conceptual surface over a small line count. Give each concept one owner and one stable term.
- Use narrow interfaces that hide internal sequencing and data. Keep authority and data flow explicit.
- Keep deterministic transforms plain, and put IO, cancellation, resources, and operational failure behind clear boundaries.
- Bound work before allocation. Prefer simple representations, one-pass data flow, and reuse of values derived from immutable inputs.
- Add an interface, service, layer, or helper only for a current ownership, lifecycle, protocol, substitution, repeated-change, or test-leverage need.
- Keep cohesive workflows together. Prefer designs that make invalid states harder to express and preserve a direct rollback or deletion path.
- Do not reorganize code only to reduce file size, line count, or a static metric. Use measured end-to-end behavior as the authority for performance changes.

## Isolate the Work

Perform agentic repository changes in a dedicated worktree. Keep the base worktree on the base branch and do not modify it for contribution work.

Follow repository policy for branch names, base synchronization, worktree placement, initialization, and resuming existing work. Before using a branch or worktree, inspect current Git state and avoid any location another session can own. Preserve local work and stop when safe synchronization requires a decision that local policy does not resolve.

## Implement and Validate

- Run focused checks while implementing. Use failures to revise the implementation or its assumptions.
- Add tests when the outcome, a known regression, or a material risk requires new evidence. Do not add tests only to restate established behavior.
- Follow specialized testing practice and repository validation policy. Run the required integration portfolio before review or integration.
- Broaden or repeat checks only when new changes, failures, unresolved concerns, or repository policy justify more evidence.

## Commit and Publish

- Inspect `git status` and the diff before committing. Commit only the intended changes.
- Resolve the push remote from repository instructions or Git configuration. Ask if it is ambiguous. Set the upstream on the first push. Do not force-push or change remote configuration unless the user explicitly requests it.
- Before preparing a pull request, inspect repository contribution guidance and applicable pull request templates.
- Explain the behavioral outcome and rationale. Record important decisions, validation, risks, and follow-up work. Do not narrate the diff or list every changed file.
- If the repository uses pull-request-only merges, do not merge locally unless the user explicitly requests it.

## Clean Up

- After merge, verify the merged pull request or equivalent forge status and confirm that the worktree is clean.
- Remove the worktree, then delete the local branch with `git branch -d`. If squash or rebase history prevents deletion, use `git branch -D` only after the user confirms that the local commits can be discarded.
