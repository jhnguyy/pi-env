---
name: git
description: Git hygiene rules for any repository: keep the base tree updated and do all branch work in dedicated git worktrees.
---

# Git Hygiene

## When to Use

Use before starting non-trivial work in any Git repository, creating or switching branches, merging work, or cleaning up a completed branch.

## Required Rules

- The base working tree is the repository checkout used to track the base branch, not a feature branch checkout. If the session starts in an arbitrary checkout, identify the base checkout before changing branches; `git worktree list` can help locate it. If multiple checkouts are on the base branch, use the primary project checkout when obvious; otherwise ask the user. If no checkout is on the base branch, ask before assigning one.
- Keep the base working tree on the base branch (`main` unless project instructions specify otherwise). If `main` is not appropriate and project instructions do not name a base branch, inspect the remote default branch (`git remote show origin` when `origin` is the remote); ask the user before assuming.
- Before starting work, sync the base branch from its upstream remote when one exists. If no upstream is configured, use `origin` only when it is the sole remote or project instructions name it as canonical; if there are multiple plausible remotes, ask the user. If no remote exists, proceed only when the base tree is clean.
- If the base tree has uncommitted changes or cannot fast-forward from its remote, stop and ask before proceeding; do not merge, rebase, or reset the base branch without user approval.
- Do not create, switch to, or edit feature branches in the base working tree.
- Do all branch work in a dedicated worktree: one branch/session per worktree. If the branch already exists locally, attach a worktree to it; if it is already checked out in another worktree, use that worktree instead. If it exists only on the remote, create the local branch from the remote branch in its worktree.
- Follow project-specific branch naming, test, merge, and push conventions when they exist.

## Lifecycle Checklist

1. Identify the base working tree and base branch.
2. Confirm the base tree is clean.
3. Fast-forward sync the base branch from its remote when a remote exists.
4. Create or attach the dedicated worktree for the work branch.
5. Do edits, tests, commits, and branch pushes from that worktree.
6. Merge the work branch into the updated base branch from the base working tree, using project conventions. If the repository uses remote PR-only merges, skip the local merge and follow that workflow.
7. Remove the completed worktree and delete the local branch only after verifying the work branch is merged or the remote PR workflow no longer needs the local branch.

## Worktree Guidance

- Use the real branch name for Git.
- Use a slash-free filesystem slug for the worktree path, e.g. `feat/example` -> `repo-feat-example`.
- Temporary worktree paths are acceptable when branch work is committed and pushed regularly; this encourages cleanup and keeps the base checkout uncluttered.
- For Git syntax details, use `git help worktree` rather than expanding this skill into a Git tutorial.
- After merge, verify the work branch is merged, then remove the completed worktree and delete the local branch with the standard Git cleanup commands (`git worktree remove`, `git branch -d`).
