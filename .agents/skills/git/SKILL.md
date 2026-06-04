---
name: git
description: Git hygiene rules for any repository: keep the base tree updated and do all branch work in dedicated git worktrees.
---

# Git Hygiene

Use before starting non-trivial work in any Git repository, creating or switching branches, merging work, or cleaning up a completed branch.

- Treat the base working tree as the checkout that tracks the base branch, not as a place for feature branch work. Use the project-specified base branch; otherwise use `main`; if `main` is not appropriate, inspect the remote default branch and ask before assuming.
- Before starting work, ensure the base working tree is on the base branch, clean (`git status --porcelain` is empty), and synchronized by fast-forwarding from its remote when one exists.
- The base branch should only need fast-forward sync from its remote. If it has uncommitted changes or cannot fast-forward, stop before proceeding.
- Do not create, switch to, or edit feature branches in the base working tree.
- Do all branch work in a dedicated worktree: one branch/session per worktree.
- Use `git worktree list` to find existing worktrees and avoid checking out the same branch in multiple worktrees. If the branch already has a worktree, use it. If the branch exists locally, attach the worktree to it. If it exists only remotely, fetch first and create the local branch/worktree from the remote-tracking branch instead of recreating it.
- Use the real branch name for Git and a slash-free filesystem slug for the worktree path, e.g. `feat/example` -> `repo-feat-example`. Temporary worktree paths are acceptable when branch work is committed and pushed regularly. Do not place worktrees inside the base working tree.
- Follow project-specific branch naming, test, merge, push, and PR conventions. If the repository uses remote PR-only merges, do not perform a local merge.
- For new work, sync the base tree first, then create a branch worktree. For existing work, find or attach the existing branch worktree. After merge or PR completion, verify the branch is no longer needed, then remove the worktree and delete the local branch (`git worktree remove`, `git branch -d`).
- For Git syntax details, use `git help worktree` rather than expanding this skill into a Git tutorial.
