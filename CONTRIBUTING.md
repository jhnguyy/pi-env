# Contributing

Use the [code-contribution skill](.agents/skills/code-contribution/SKILL.md) for the contribution method. This page covers the repository's working environment and verification choices; [README](README.md) covers setup modes.

## Isolate the work

Keep the primary checkout on stable `main`. Develop each pull request in its own branch and worktree outside that checkout, and squash-merge through a pull request. Worktrees separate source and Git state that concurrent sessions, editors, and language servers would otherwise share.

Initialize a new worktree from within it:

```sh
nub run --no-check worktree:init
```

Each worktree needs its own dependency links and extension bundles. Sharing `node_modules` or extension `dist` directories can mix branches' runtime behavior even when their source trees are separate.

In Nix-backed setups, Nix supplies the toolchain. Nub manages repository dependencies and package scripts. Use the setup mode that matches the host rather than trying to realize Nix store paths inside an externally managed runtime. The declared Node compatibility range lives in `package.json`.

## Verification

Use `nub run verify` for change-scoped feedback. Inspect the selection with `--list`, choose a comparison ref with `--base <ref>`, or omit tests with `--checks-only`.

Local selection is necessarily incomplete for some changes, especially configuration, dependencies, generated artifacts, and dynamic inputs. CI combines changed-file policy with `nub run verify:full` for broader integration coverage. A green local run is useful evidence, not a claim that every consequence of the change has been checked.

Full verification can exhaust a shared machine even with low worker concurrency. Prefer CI for that work; agree on scope and available capacity before a full local run. Individual checks and their commands are available in [`package.json#scripts`](package.json).

Some evidence needs an explicit environment qualification:

- `nub run test:canary` exercises dev-tools against the real workspace. Retain the evidence it reports when the result is needed for review.
- `nub run test:e2e:session-manager:docker` exercises real Pi session ownership in an isolated tmux environment. See [session identity and display names](docs/session-manager.md) for the contract.

The [testing guidance](docs/conventions/testing.md) explains how to choose evidence. Resource limits and selection strategies are operating choices, not substitutes for the behavior a change must establish.

## Repository conventions

Follow [extension conventions](docs/conventions/extensions.md) for runtime boundaries and lifecycle ownership, and [documentation conventions](docs/conventions/documentation.md) for durable guidance. Keep commands and implementation settings in their executable owners rather than copying them into policy.
