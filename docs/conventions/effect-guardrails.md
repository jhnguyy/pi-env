# Effect guardrails

Effect is for IO/resource/concurrency boundaries and workflows with expected operational failure. Deterministic transforms should stay plain TypeScript unless an Effect seam materially improves typed failure handling or resource safety. Not every repo file should use Effect; pure transforms and the dependency-free bootstrap path should remain plain when that is clearer.

## Coverage and inventory

Effect v4 preparation, the current dependency trust gate, and the staged migration order live in [`../effect-v4-readiness.md`](../effect-v4-readiness.md). Until migration begins, `nub run check:effect-v4` prevents known v3-only API usage from growing and requires the baseline to decrease with source migrations.

- Type-aware Effect diagnostics cover authored TypeScript included by `tsconfig`.
- The syntax checker covers tracked TS/JS/MJS under `.pi/extensions`, `src`, `scripts`, `setup`, and `.agents`.
- Historical P0 inventory is point-in-time review data. Do not rewrite it as a current complete inventory; refresh or supersede it explicitly when taking a new inventory.

## Failure model

- Expected operational failures use typed/tagged errors (`Data.TaggedError`, existing domain tagged errors, or equivalent discriminated data).
- `Effect.sync` is only for synchronous work that is not expected to throw.
- Expected-fallible synchronous work uses `Effect.try` so the error channel is explicit.
- Use scoped resource patterns (`acquireUseRelease`, `Scope`, finalizers) when acquiring resources, registering listeners, or opening subprocess/filesystem handles that need cleanup.

## Composition

- Do not use `flow(...)` composition in repo TypeScript/JavaScript. Prefer explicit `pipe(value, Effect.map(fn))` or `value.pipe(Effect.map(fn))` composition.
- Do not pass bare references to the guarded overloaded Effect combinators. Call them at the composition site so overload inference stays local and readable.
- Effect value constants such as `Effect.void` are valid.

## Boundaries

Compatibility runners (`Effect.runPromise`, `Effect.runSync`, `Effect.runFork`, `NodeRuntime.runMain`) belong at deliberate boundaries: extension/tool entrypoints, CLI/bootstrap adapters, test harnesses, and supervised process/fiber edges. Keep Effect-returning core APIs available behind those wrappers when callers benefit from typed failures.
