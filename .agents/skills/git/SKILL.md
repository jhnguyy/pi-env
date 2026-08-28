---
name: git
description: "Prepares and manages changes in Git repositories, including instruction discovery, dedicated worktrees, commits, pull requests, publishing, and cleanup. Use before modifying a Git repository or performing branch, commit, push, pull-request, merge, or cleanup work."
---

# Git Change Workflow

Use when starting, resuming, committing, publishing, or cleaning up work in a Git repository.

## Prepare

- Read the repository instructions before changing files. Read `README.md` and `CONTRIBUTING.md` when they exist. Follow linked and area-specific instructions that apply to the change.
- Determine the base branch from the repository instructions or the remote default branch. Ask if neither source identifies it.
- Reserve the base worktree for the base branch. Do not create, switch to, or edit a feature branch there.

## Start or Resume Work

- Before new work, confirm that the base worktree is on the base branch and clean. If the base branch has an upstream, fetch it. Stop if the branch is ahead of its upstream or has diverged. Fast-forward the branch if it is behind.
- Create each new branch from the updated base branch in a dedicated worktree outside the base worktree.
- Before resuming a branch, inspect `git worktree list`. If the current worktree has the branch, continue there. If another worktree has it, ask whether that worktree is free before use.
- If the branch has no worktree, attach one to the local branch. If the branch exists only on a remote, fetch it first and create the local branch and worktree from the remote-tracking branch.

## Commit and Publish

- Inspect `git status` and the diff before committing. Run the repository-required validation and commit only the intended changes.
- Resolve the push remote from the repository instructions or Git configuration. Ask if the remote is ambiguous. Set the upstream on the first push, then use that upstream. Do not force-push or change remote configuration unless the user explicitly requests it.
- Before preparing a pull request, inspect repository contribution guidance such as `CONTRIBUTING.md` and applicable pull request template files such as `.github/pull_request_template.md`.
- Follow the applicable instructions and template. Create or update the pull request for the actual change.
- Explain the behavioral outcome and rationale. Record important decisions, validation, risks, and follow-up work.
- Do not narrate the diff or list every changed file.
- If the repository uses pull-request-only merges, do not merge locally unless the user explicitly requests it.

## Clean Up

- After merge, verify the merged pull request or equivalent forge status and confirm that the worktree is clean. Remove the worktree, then delete the local branch with `git branch -d`. If squash or rebase history prevents deletion, use `git branch -D` only after the user confirms that the local commits can be discarded.
