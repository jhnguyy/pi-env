# Effect guardrails

Effect is for IO/resource/concurrency boundaries and workflows with expected operational failure. Deterministic transforms should stay plain TypeScript unless an Effect seam materially improves typed failure handling or resource safety.

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
