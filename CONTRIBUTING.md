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

## Runtime Requirements

Use Nub with Node.js 22.19+. The repo includes `.node-version` / `.nvmrc` pinned to `22.19.0`; setup asks Nub to provision/resolve that Node. Node remains the runtime for pi; Nub owns dependency install and script orchestration.

## Extension Development

Extensions compile to `dist/index.js` Node ESM bundles for fast load times. Source files in `.pi/extensions/*/` are never loaded directly by pi at runtime.

Use `package.json` scripts as the source of truth for build, test, cleanup, and verification commands.

The build uses `scripts/build-extensions.mjs` with esbuild. Active extension names come from `package.json`'s `pi.extensions` list; `pi-build.config.json` holds build-only details such as external packages and sidecar bundles. Pi peer packages are externalized so the runtime copies provided by pi are used instead of bundled duplicates.

The build runs during `nub install`/setup via `postinstall` plus an explicit setup build step. Install/setup intentionally does not run the full test suite; it stays focused on making the local Pi environment current without burning CPU on routine pulls.

### Adding a new extension

1. Create `.pi/extensions/<name>/index.ts` with the default export
2. Add `.pi/extensions/<name>/package.json` with name `@pi-env/<name>` and `"type": "module"`
3. Add `.pi/extensions/<name>` to `package.json`'s `workspaces` and `pi.extensions` lists
4. Run the package build script

### Cross-extension singletons

Store shared services on `globalThis`, not at module level — module-level variables are per-bundle; `globalThis` is process-wide.

## Worktree Isolation

**Always use a worktree for branch work.** The main working tree (`/mnt/tank/code/pi-env`) stays on `main`. Never `git checkout -b` there — concurrent sessions share the index and working tree, so any checkout in the main tree risks colliding with another session's uncommitted work.

```bash
# Start work — always from a worktree
git worktree add /tmp/pi-env-<branch> -b <branch>
cd /tmp/pi-env-<branch>

# Do work, commit, push ...

# Merge (from the main working tree)
cd <repo-root>
git merge --no-ff <branch>
git push origin main

# Clean up
git worktree remove /tmp/pi-env-<branch>
git branch -d <branch>
```

Concurrent sessions, editors, and the LSP daemon all share the working tree — a checkout changes HEAD for all of them simultaneously. Worktrees give each session its own HEAD and index.
