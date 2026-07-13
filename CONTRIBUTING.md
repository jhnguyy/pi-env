# Contributing

Solo project — these conventions exist so `git log --graph` stays readable and the work-tracker extension has a stable contract to enforce.

## Branch and PR convention

```
feat/<name>       new extension, tool, or capability
fix/<name>        bug fix
refactor/<name>   behavior-preserving structural change
chore/<name>      config, docs, cleanup
```

- `main` is stable; repository changes go through pull requests.
- Every pull request uses a dedicated branch and worktree, even solo.
- PRs are squash-merged into `main`.
- Delete branches after merge.
- Tag milestones on `main`: `v<major>.<minor>.0`

## Documentation changes

Implementation conventions live under [`docs/conventions/`](docs/conventions/README.md). Start with the overview and follow the area-specific page that matches the work.

Keep documentation targeted:

- `README.md`: purpose, setup choices, navigation.
- `CONTRIBUTING.md`: branch, PR, worktree, reviewer, and test policy.
- `AGENTS.md`: coding-agent workflow.

Cross-link when useful. Keep navigation docs as thin link chains. Do not duplicate guidance already owned by code, config, or scripts. Comments should record constraints, alternatives, or domain meaning rather than narrate control flow.

## Runtime requirements

Use Nub with the Node.js version required by `package.json#engines.node`. Setup validates the resolved runtime against `package.json`. Node remains the runtime for pi; Nub owns dependency install and script orchestration.

Before assuming a toolchain problem is a code problem, verify whether the host can execute Nub, whether Node satisfies `package.json#engines.node`, and whether Nix is local (`nix run` can realize store paths) or externally managed (`--nix-managed`, no local store writes). If a fix depends on one of those assumptions, update README/setup docs with the expectation.

## Extension development

Extension implementation conventions live in [`docs/conventions/extensions.md`](docs/conventions/extensions.md). Use that page for runtime shape, lifecycle manifest, tool output, and cross-bundle singleton rules.

Source-owned contracts:

- active extensions: [`package.json`](package.json)
- lifecycle manifest: [`scripts/extension-manifest.mjs`](scripts/extension-manifest.mjs)
- scripts: [`package.json#scripts`](package.json)

Arguments to `nub run` are forwarded directly; do not insert `--` before a Vitest file filter. `test:changed` uses Vitest's dependency graph relative to the optional Git ref. TypeScript checking remains repository-wide for soundness. Run the safe verification portfolio before integration when the full workspace contract is required.

## Testing and review

Follow [`docs/conventions/testing.md`](docs/conventions/testing.md) for test classes, independent hardening-test design, catching-test policy, and verification portfolios. Catching tests are ephemeral and may not be committed.

Risk-triggered changes must record test intent and independent requirement-derived scenarios in the pull request. Reviewers should verify that the chosen tests match the risk and that source-owned scripts/config remain the authority.

Canonical verification phases live in [`scripts/verification-phases.mjs`](scripts/verification-phases.mjs). Safe verification lives in [`scripts/safe-verification-plan.mjs`](scripts/safe-verification-plan.mjs).

## Worktree isolation

**Always use a worktree for branch work.** The main working tree (`/mnt/tank/code/pi-env`) stays on `main`. Never `git checkout -b` there — concurrent sessions share the index and working tree, so any checkout in the main tree risks colliding with another session's uncommitted work.

```bash
# Start work — always from a worktree
git worktree add /tmp/pi-env-<branch> -b <branch>
cd /tmp/pi-env-<branch>

# Do work, commit, push, open PR ...

# After squash merge
cd <repo-root>
git fetch --prune origin
git switch main
git pull --ff-only

# Clean up after confirming the PR is merged
git worktree remove /tmp/pi-env-<branch>
git branch -D <branch>
```

Concurrent sessions, editors, and the LSP daemon all share the working tree — a checkout changes HEAD for all of them simultaneously. Worktrees give each session its own HEAD and index.
