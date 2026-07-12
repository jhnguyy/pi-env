# Effect conventions

`package.json` is the source of truth for the Effect version used by pi-env. The repository currently runs Effect 3; do not introduce Effect 4 APIs until a separately approved migration changes that dependency.

## Effect Solutions workflow

**Important:** consult Effect Solutions before writing or reviewing Effect code.

1. Run `effect-solutions list` to see the available guides.
2. Run `effect-solutions show <topic>...` for the patterns relevant to the task.
3. Verify every API against the installed `effect` package, its types, and existing pi-env code before using it.

Topics include `quick-start`, `project-setup`, `tsconfig`, `basics`, `services-and-layers`, `data-modeling`, `error-handling`, `config`, `testing`, and `cli`.

Never guess at Effect patterns. The guides express preferred design direction, but the installed Effect 3 API is authoritative for current code. Schema is available from `effect/Schema`; do not add the deprecated `@effect/schema` package.

The `effect-solutions` CLI is development tooling, not part of pi-env's runtime. pi-env remains a Nub-managed Node project; do not add Bun or `@effect/platform-bun` to the repository merely to support the CLI.

## Compiler diagnostics baseline

The Effect language service is patched into the workspace TypeScript compiler during `prepare`. Effect errors fail `nub run typecheck`. Existing Effect warnings and suggestions remain visible but do not affect the exit code while the P0 diagnostic backlog is being resolved; `ignoreEffectWarningsInTscExitCode` records that deliberate baseline in `tsconfig.json`.

Do not suppress new diagnostics inline merely to obtain a green build. Fix them when they are local to the current change, or record a focused migration follow-up when they expose pre-existing architecture debt. Remove the warning baseline only after the repository is warning-clean.

## Local Effect v4 source

The Effect v4 source is kept at `~/.local/share/effect-solutions/effect` as a forward-looking implementation reference:

```bash
git clone --depth 1 https://github.com/Effect-TS/effect-smol.git ~/.local/share/effect-solutions/effect
git -C ~/.local/share/effect-solutions/effect pull --depth 1 --ff-only
```

Use this checkout to understand implementation direction and to prepare an intentional Effect 4 migration. While pi-env remains on Effect 3, do not copy an API or type signature from the v4 checkout unless the installed Effect 3 types confirm compatibility. Prefer the installed package and current repository implementations for code that must work now.

## Repository boundaries

- Keep `Effect.run*` at Pi, CLI, or executable boundaries.
- Preserve Promise-returning and Pi-facing APIs as compatibility adapters unless a public-contract change is approved.
- Use typed errors for expected operational failures and defects only for unexpected invariants.
- Use `Effect` for IO, interruption, scoped resources, or composed asynchronous workflows; keep deterministic transforms plain TypeScript.
- Preserve TypeBox for Pi tool parameter contracts. Use Effect Schema for persisted configuration, environment input, protocol payloads, and semantic validation where the migration roadmap calls for it.
- Follow [TypeScript conventions](typescript.md) for tagged data, compatibility seams, and bootstrap constraints.
