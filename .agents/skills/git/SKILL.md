---
name: git
description: Git hygiene rules for any repository: keep the base tree on an updated base branch and do all branch work in dedicated git worktrees.
---

# Git Hygiene

## When to Use

Use before starting non-trivial work in any Git repository, creating/checking out a branch, merging work, or cleaning up a completed branch.

## Core Rules

- Keep the base working tree on the base branch (`main` unless project instructions specify otherwise).
- Update the base branch from its remote before starting work.
- Do not create, switch to, or edit feature branches in the base working tree.
- Do all branch work in a dedicated worktree: one branch/session per worktree.
- Stop and ask the user if the base tree is dirty, ahead of remote, diverged from remote, or cannot fast-forward.
- Follow project-specific branch naming, test, merge, and push conventions when they exist.

## Workflow

1. From the repository root, confirm the base tree is clean and on the base branch.
2. Fast-forward the base branch from its remote. If the repository has no remote, require only a clean base tree.
3. Create or enter a worktree for the work branch.
   - Use the real branch name for Git.
   - Use a slash-free filesystem slug for the worktree path, e.g. `feat/example` -> `repo-feat-example`.
   - Prefer a durable repo-adjacent path unless project instructions specify another location.
4. Perform all edits, tests, commits, and review inside the worktree.
5. Merge only from the updated base tree. Prefer `git merge --no-ff` unless project instructions say otherwise.
6. If merge conflicts occur, resolve and test in the base tree, then commit the merge; if unsure, abort and ask the user.
7. Remove the worktree and delete the local branch after merge.
8. Push branches or the merged base only when the user explicitly requests it.

## Minimal Command Shapes

These are reminders, not a script. Adapt paths, branch names, and base branch to the repository.

```bash
# Update base tree before work
git switch <base-branch>
git status --short --branch
git pull --ff-only

# New work branch in its own worktree
git worktree add <repo-adjacent-worktree-path> -b <branch-name>

# Existing branch in its own worktree
git worktree add <repo-adjacent-worktree-path> <branch-name>

# Merge and cleanup from the base tree
git switch <base-branch>
git pull --ff-only
git merge --no-ff <branch-name>
git worktree remove <repo-adjacent-worktree-path>
git branch -d <branch-name>
```
