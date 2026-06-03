---
name: git
description: Git hygiene rules for any repository: keep the base tree updated and do all branch work in dedicated git worktrees.
---

# Git Hygiene

## When to Use

Use before starting non-trivial work in any Git repository, creating or switching branches, merging work, or cleaning up a completed branch.

## Required Rules

- The base working tree is the repository checkout used to track the base branch, not a feature branch checkout.
- Keep the base working tree on the base branch (`main` unless project instructions specify otherwise). If multiple plausible base branches exist, prefer explicit project instructions, then the remote default branch; otherwise ask the user.
- Before starting work, sync the base branch from its remote when one exists. If no remote exists, proceed only when the base tree is clean.
- Do not create, switch to, or edit feature branches in the base working tree.
- Do all branch work in a dedicated worktree: one branch/session per worktree.
- Follow project-specific branch naming, test, merge, and push conventions when they exist.

## Worktree Guidance

- Use the real branch name for Git.
- Use a slash-free filesystem slug for the worktree path, e.g. `feat/example` -> `repo-feat-example`.
- Prefer a durable repo-adjacent worktree path unless project instructions specify another location: a sibling directory of the base checkout, not a temporary directory likely to be cleaned automatically.
- This skill intentionally omits full command sequences; for Git syntax details, use `git help worktree` rather than expanding this skill into a Git tutorial.
- After merge, remove the completed worktree and delete the local branch with the standard Git cleanup commands (`git worktree remove`, `git branch -d`).

## When to Ask the User

Stop and ask before proceeding when:

- the base tree has uncommitted changes
- the base branch is ahead of its remote
- the base branch has diverged from its remote
- the base branch cannot fast-forward from its remote; do not merge, rebase, or reset the base branch without user approval
- the repository has no clear base branch and project instructions do not specify one
