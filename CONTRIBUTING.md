# Contributing

Solo project — these conventions exist so `git log --graph` stays readable and the work-tracker extension has a stable contract to enforce.

## Branch Convention

```
feat/<name>    new extension, tool, or capability
fix/<name>     bug fix
chore/<name>   config, docs, cleanup (no behavior change)
```

- `main` = stable. Direct commits only for trivial one-liners (typo, single-line comment).
- Every piece of real work gets a branch, even solo.
- Merge with `--no-ff` to preserve branch topology: `git merge --no-ff feat/<name>`
- Delete branch after merge: `git branch -d feat/<name>`
- Tag milestones on `main`: `v<major>.<minor>.0`

## Pi Version Bumps

After bumping pi packages in `package.json`, regenerate the capability map:

```bash
bun install
bash scripts/generate-capability-map.sh
```

Include the updated `docs/pi-capability-map.md` in the bump commit.

## Worktree Isolation

**Always use a worktree for branch work.** The main working tree (`/mnt/tank/code/pi-env`) stays on `main`. Never `git checkout -b` there — concurrent sessions share the index and working tree, so any checkout in the main tree risks colliding with another session's uncommitted work.

```bash
# Start work — always from a worktree
git worktree add /tmp/pi-env-<branch> -b <branch>
cd /tmp/pi-env-<branch>

# Do work, commit, push ...

# Merge (from the main working tree)
cd /mnt/tank/code/pi-env
git merge --no-ff <branch>
git push origin main

# Clean up
git worktree remove /tmp/pi-env-<branch>
git branch -d <branch>
```

### Why not checkout in the main tree?

Multiple pi sessions, editors, and background tools (LSP daemon, file watchers) share `/mnt/tank/code/pi-env`. A `git checkout` changes HEAD, index, and working tree for **all** of them simultaneously. This causes:
- Commits landing on the wrong branch (session A checks out branch X, session B commits thinking it's on main)
- Uncommitted changes from one session appearing as dirty files in another
- LSP daemon reindexing on every checkout, slowing all sessions

Worktrees give each session its own HEAD, index, and working tree. The main tree stays on `main` as a stable reference point.

## Example Workflow

```bash
git worktree add /tmp/pi-env-notes -b feat/notes-patch
cd /tmp/pi-env-notes
# ... do work, commit, push ...
cd /mnt/tank/code/pi-env
git merge --no-ff feat/notes-patch
git push origin main
git worktree remove /tmp/pi-env-notes
git branch -d feat/notes-patch
```


