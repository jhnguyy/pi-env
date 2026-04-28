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

## Extension Development

Extensions compile to `dist/index.js` bundles (Bun, ESM) for fast load times. Source files in `.pi/extensions/*/` are never loaded directly by pi at runtime.

**After any extension source change:**

```bash
bun run build
```

**Or rebuild a single extension:**

```bash
bun build .pi/extensions/<name>/index.ts \
  --outfile .pi/extensions/<name>/dist/index.js \
  --target bun --format esm \
  --external @mariozechner/pi-coding-agent \
  --external @mariozechner/pi-ai \
  --external @mariozechner/pi-tui \
  --external @mariozechner/pi-agent-core \
  --external @sinclair/typebox
```

The build runs automatically on `bun install` via `postinstall`.

### Adding a new extension

1. Create `.pi/extensions/<name>/index.ts` with the default export
2. Add `.pi/extensions/<name>/package.json` with name `@pi-env/<name>` and `"type": "module"`
3. Add `<name>` to the `EXTENSIONS` array in `scripts/build-extensions.sh`
4. Run `bun run build`

### Cross-extension singletons

Store shared services on `globalThis`, not at module level — module-level variables are per-bundle; `globalThis` is process-wide.

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
cd <repo-root>
git merge --no-ff <branch>
git push origin main

# Clean up
git worktree remove /tmp/pi-env-<branch>
git branch -d <branch>
```

Concurrent sessions, editors, and the LSP daemon all share the working tree — a checkout changes HEAD for all of them simultaneously. Worktrees give each session its own HEAD and index.




