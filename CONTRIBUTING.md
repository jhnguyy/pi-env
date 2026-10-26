# Contributing

Before contributing, read and follow [the `code-contribution` skill](.agents/skills/code-contribution/SKILL.md). It owns the portable contribution method used for all repository work. This file defines pi-env-specific requirements.

Solo project — these requirements keep `git log --graph` readable and give the work-tracker extension a stable contract to enforce.

## Branch and PR convention

```
feat/<name>       new extension, tool, or capability
fix/<name>        bug fix
refactor/<name>   behavior-preserving structural change
chore/<name>      config, docs, cleanup
```

- `main` is stable. Repository changes go through pull requests.
- Every pull request uses a dedicated branch and worktree, even solo.
- PRs are squash-merged into `main`.
- Delete branches after merge.
- Tag milestones on `main`: `v<major>.<minor>.0`

## Documentation changes

Follow `docs/conventions/documentation.md` for documentation placement, README scope, navigation, cross-links, prose, and comments.

## Runtime requirements

Nix owns provisioning and uses Pi's upstream package. Nub owns repository dependency install and script orchestration, and supplies the single portable fallback. `package.json#engines.node` declares compatibility, not an exact patch pin. Flake evaluation checks Node, Nub, and Pi development-package consistency.

Before assuming a toolchain problem is a code problem, verify whether the host can execute Nub, whether Node satisfies `package.json#engines.node`, and whether Nix is local (`nix run` can realize store paths) or externally managed (`--nix-managed`, no local store writes). If a fix depends on one of those assumptions, update README/setup docs with the expectation.

## Extension development

Extension implementation conventions live in [`docs/conventions/extensions.md`](docs/conventions/extensions.md). Use that page for runtime shape, lifecycle manifest, tool output, and cross-bundle singleton rules.

Source-owned contracts:

- active extensions: [`package.json`](package.json)
- lifecycle manifest: [`scripts/extension-manifest.mjs`](scripts/extension-manifest.mjs)
- scripts: [`package.json#scripts`](package.json)

Arguments to `nub run` are forwarded directly. Do not insert `--` before a Vitest file filter. TypeScript checking remains repository-wide for soundness.

## Testing and review

Follow [`docs/conventions/testing.md`](docs/conventions/testing.md) for E2E-first testing and evidence requirements. Catching tests are ephemeral and may not be committed.

Canonical standard and safe verification phases live in [`scripts/verification-phases.mjs`](scripts/verification-phases.mjs). Test projects live in [`vitest.config.ts`](vitest.config.ts). Run the safe verification portfolio before integration when the full workspace contract is required.

Run the dev-tools real-workspace canary with retained evidence:

```bash
PI_ENV_CANARY_ARTIFACT_DIR="$HOME/canary-evidence" nub run verify:phase real-workspace-semantic-canary
```

Retain that directory for review. The [canary](.pi/extensions/dev-tools/__tests__/real-workspace-canary.e2e.test.ts) owns the artifact format and default storage location.

Run the session-manager E2E in Docker to isolate tmux from the host. See [session identity and display names](docs/session-manager.md) for the behavioral contract:

```bash
nub run test:e2e:session-manager:docker
```

The [bake targets](docker-bake.hcl) own build options, caching, and evidence export.

## Worktree requirements

Keep the primary working tree on `main`. Perform all branch work in a dedicated worktree outside the primary working tree. Concurrent sessions, editors, and the LSP daemon share each working tree, index, and checkout.

After creating a worktree, run:

```bash
nub run --no-check worktree:init
```

Each worktree requires its own dependency links and extension build artifacts. Do not share `node_modules` or extension `dist` directories between worktrees.
