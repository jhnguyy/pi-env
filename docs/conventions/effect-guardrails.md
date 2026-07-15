# Effect guardrails

Effect is for IO/resource/concurrency boundaries and workflows with expected operational failure. Deterministic transforms should stay plain TypeScript unless an Effect seam materially improves typed failure handling or resource safety. Not every repo file should use Effect; pure transforms and the dependency-free bootstrap path should remain plain when that is clearer.

The pinned Effect declarations, repository typecheck, and runtime tests are authoritative. External examples and newer APIs are inputs, not conventions, until they fit the pinned release and nearby code.

## Coverage

- Type-aware Effect diagnostics cover authored TypeScript included by `tsconfig`.
- The syntax checker covers tracked TS/JS/MJS under `.pi/extensions`, `src`, `scripts`, `setup`, and `.agents`.

## Data and failure

- Decode untrusted input at the adapter edge before it reaches core workflows. Use `Schema.decodeUnknownEffect` when a schema is warranted, or `Result` for pure synchronous parsing; reserve throwing decoders and constructors for trusted startup/test paths.
- Use Schema models for reusable encoded, persisted, or boundary-crossing contracts. Keep internal records and control data plain TypeScript or `Data` variants when they do not need runtime decoding; a same-name Schema interface is optional rather than a repo requirement.
- Use `Schema.optionalKey` when an encoded key may be absent. Use `Schema.optional` only when explicit `undefined` is part of the in-memory contract.
- Expected operational failures use `Data.TaggedError` or equivalent discriminated data when they stay local. Use schema-backed tagged errors when the error itself needs decoding, encoding, persistence, or a public transport contract.
- `Effect.sync` is only for synchronous work that is not expected to throw. Expected-fallible synchronous work uses `Effect.try` so the error channel is explicit.
- Recover typed failures at the narrowest boundary that can respond truthfully. Cause-level recovery belongs at supervision boundaries; preserve interruption and let defects remain visible by default.
- A fallback must be real domain behavior, not a way to erase an exhausted or unclassified failure.
- Use scoped resource patterns (`acquireUseRelease`, `Scope`, finalizers) when acquiring resources, registering listeners, or opening subprocess/filesystem handles that need cleanup.

## Services, layers, and lifecycle

- Add services and layers for meaningful substitution, shared acquisition, or lifecycle ownership—not to wrap every module. Keep required authority, credentials, persistence, and transports explicit.
- When a service is warranted, use the repository's established `Context.Service` style unless a compatibility boundary requires another tag representation.
- Match layer construction to acquisition: already-built values use `Layer.succeed`, lazy synchronous construction uses `Layer.sync`, and effectful acquisition uses `Layer.effect`.
- Acquire expensive clients and construct shared caches once in their owning layer or scope. A cache or client built per operation does not provide shared lifecycle or deduplication.
- Long-lived listeners, workers, and stream consumers must fork into an owning scope with `Effect.forkScoped` or an equivalent scoped supervisor. Layer acquisition itself must complete.
- Wire dependencies deliberately. Do not use broad layer merging or merged provisioning merely to silence an environment-type error.

## Time, repetition, streams, and caches

- Use `Schedule` with `Effect.retry` or `Effect.repeat` for bounded retry, polling, pacing, and backoff instead of manual sleep loops. Retry only a proven-idempotent operation, at its narrowest useful boundary, and keep exhaustion visible unless a truthful fallback exists.
- Use `Stream` when a source emits ordered values over time and needs pull, backpressure, interruption, or stream transforms. Use `Effect.repeat` for one recurring operation that emits no meaningful values; do not collect unbounded streams.
- Prefer Effect cache primitives over hand-rolled TTL, eviction, or in-flight-deduplication maps when their semantics fit. Bound cache capacity, choose failure TTLs deliberately, and own the cache in a shared layer or scope.

## Adapters and runtime boundaries

- External HTTP, SDK, CLI, and process adapters own request construction, cancellation, response/status classification, boundary decoding, and translation to domain errors. If raw `fetch` is the appropriate adapter, pass the `AbortSignal` supplied by the Effect boundary.
- Read and validate runtime configuration once at an adapter/layer boundary, then inject typed values. Use `Config` and `ConfigProvider` when provider substitution is useful; dependency-free bootstrap code may instead accept an explicit environment record.
- Prefer an Effect- or Result-returning core API and keep throwing or Promise-returning wrappers at compatibility edges. Bootstrap code that runs before install must not import dependency-backed Effect modules at top level.
- Compatibility runners (`Effect.runPromise`, `Effect.runSync`, `Effect.runFork`, `NodeRuntime.runMain`) belong at deliberate boundaries: extension/tool entrypoints, CLI/bootstrap adapters, test harnesses, and supervised process/fiber edges. Keep Effect-returning core APIs available behind those wrappers when callers benefit from typed failures.

## Composition

- Use `Effect.gen` for multi-step sequential workflows. Keep single transforms and short local compositions as direct effects or explicit pipes.
- Use `Effect.fn("Domain.operation")` when a reusable operation benefits from named stack frames or spans. Use `Effect.fnUntraced` for reusable internal generator helpers where that metadata is intentionally unnecessary; do not trace trivial or hot helpers solely for uniformity.
- Do not use `flow(...)` composition in repo TypeScript/JavaScript. Prefer explicit `pipe(value, Effect.map(fn))` or `value.pipe(Effect.map(fn))` composition.
- Do not pass bare references to the guarded overloaded Effect combinators. Call them at the composition site so overload inference stays local and readable.
- Effect value constants such as `Effect.void` are valid.

## Tests

- Use `@effect/vitest`'s `it.effect` for Effect-native tests. Use `it.live` only when real time or live runtime services are the behavior under test; keep regular Vitest tests for plain TypeScript and compatibility adapters.
- Substitute Effect-owned dependencies with explicit services/layers or existing seams instead of mutating global process state.
- Use `TestClock` for Effect time and deterministic primitives such as `Deferred`, `Queue`, `Latch`, or `Ref` for fiber coordination. Do not add arbitrary sleeps to make concurrency tests pass.
- When relevant to the behavior, assert typed failures, interruption, finalization, retry bounds, and idempotency. Repository-wide test classifications and verification policy still apply.
