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

## Prepare the Worktree

- Determine the base branch from repository instructions or the remote default branch. Ask if neither source identifies it.
- Reserve the base worktree for the base branch. Do not create, switch to, or edit a feature branch there.
- Before new work, confirm that the base worktree is on the base branch and clean. If the base branch has an upstream, fetch it. Stop if the branch is ahead of its upstream or has diverged. Fast-forward it if it is behind.
- Create each new branch from the updated base branch in a dedicated worktree outside the base worktree.
- Before resuming a branch, inspect `git worktree list`. If another worktree has the branch, ask whether that worktree is free before use. If the branch has no worktree, attach one to the local branch. If it exists only on a remote, fetch it and create the local branch and worktree from the remote-tracking branch.

## Implement and Validate

- Run focused checks while implementing. Use failures to revise the implementation or its assumptions.
- Add tests when the outcome, a known regression, or a material risk requires new evidence. Do not add tests only to restate established behavior.
- Follow specialized testing practice and repository validation policy. Run the required integration portfolio before review or integration.

## Commit and Publish

- Inspect `git status` and the diff before committing. Commit only the intended changes.
- Resolve the push remote from repository instructions or Git configuration. Ask if it is ambiguous. Set the upstream on the first push. Do not force-push or change remote configuration unless the user explicitly requests it.
- Before preparing a pull request, inspect repository contribution guidance and applicable pull request templates.
- Explain the behavioral outcome and rationale. Record important decisions, validation, risks, and follow-up work. Do not narrate the diff or list every changed file.
- If the repository uses pull-request-only merges, do not merge locally unless the user explicitly requests it.

## Clean Up

- After merge, verify the merged pull request or equivalent forge status and confirm that the worktree is clean.
- Remove the worktree, then delete the local branch with `git branch -d`. If squash or rebase history prevents deletion, use `git branch -D` only after the user confirms that the local commits can be discarded.
