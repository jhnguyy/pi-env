---
name: typescript-effect
description: Designs, implements, and tests TypeScript Effect workflows, services, schemas, adapters, and resource lifecycles. Use when Effect is in use or proposed, including API migrations and concurrency or failure-handling changes.
---

# TypeScript Effect

## Find version-matched guidance

1. Read project instructions, local Effect practices, dependency versions, and nearby code and tests.
2. Verify the relevant exports and signatures against installed declarations. Inspect matching source when types alone do not explain behavior.
3. Search version-matched `LLMS.md` and `ai-docs/src` for the APIs and concepts involved. Read only the relevant sections and examples.
4. If the installed package omits those docs, consult upstream at the project's release tag or matching source revision. Do not mix v3, v4 prerelease, and stable v4 recipes. Treat newer upstream and community guidance as secondary evidence.
5. Resolve material API questions through matching guidance or source and tests before implementation. Verify the result with the consuming project's typecheck and runtime tests.

Use these topics to focus retrieval, not as a fixed API recipe:

| Task | Find guidance for |
| --- | --- |
| Data and failures | Schema decoding, refined domain values, tagged errors, typed recovery versus causes |
| Services and lifecycle | Context, Layer construction and composition, scopes, finalizers, shared acquisition |
| Concurrency and repetition | Fiber ownership, cancellation, bounded concurrency, Schedule retry and repeat policies |
| Repeated data access | Stream backpressure, Cache lifetime and failure caching, RequestResolver batching |
| Adapters and execution | Config, HttpClient, Promise cancellation, runtime integration and shutdown |
| Tests | The project's Effect test harness, test layers, TestClock, deterministic fiber coordination |

Distinguish library contracts from application style. Follow project conventions for records, error representations, service organization, and module exports. Do not turn one guide's modeling preferences into universal Effect requirements.

## Define the workflow boundary

- Start with the workflow's success, expected failures, and dependencies.
- Parse untrusted input at the edge into the refined domain type the workflow needs. Do not validate and continue with the broad input type. Complete required input parsing before durable or external effects begin.
- Use Effect for IO, expected operational failure, interruption, scoped resources, concurrency policy, or dependency substitution. Keep deterministic transforms in plain TypeScript unless typed failure handling warrants an Effect boundary.
- Use Schema for reusable decoded or encoded contracts when warranted. Do not require runtime schemas for every internal record or local error.
- Add services and layers for meaningful substitution, shared acquisition, or lifecycle ownership, not to wrap every module.
- Preserve public adapters unless the task intentionally changes them. Keep runtime execution at deliberate entrypoints and compatibility boundaries, not inside Effect-returning core workflows.

## Implement failure and lifecycle policy

- Model expected failures in the Effect error channel. Wrap expected-fallible synchronous or Promise APIs with the matching Effect constructors. Do not use JavaScript `try`/`catch` inside `Effect.gen`.
- Recover typed errors at the narrowest boundary that can respond truthfully. Reserve cause-level recovery for supervision boundaries. Preserve interruption and leave defects visible by default.
- Use `return yield*` for terminal failure and interruption effects in generators.
- Use `Effect.gen` for sequential workflows. For reusable generator functions, use named `Effect.fn` when operation metadata is useful and `Effect.fnUntraced` when it is intentionally unnecessary.
- Own acquired resources and background fibers in a scope with finalizers. Fork long-lived work into its owner's scope so layer acquisition can complete. Acquire shared clients and caches once in their owning layer or scope.
- Make concurrency bounds and cancellation policy explicit. Propagate cancellation to external adapters where supported. Fiber interruption alone does not prove external work stopped.
- Use Schedule for retry and repetition when it fits. Bound retries and apply them only to eligible failures of proven-idempotent operations. Keep exhaustion visible unless the boundary has a real fallback.
- Prefer Effect streams, caches, and batching primitives when their semantics fit. Do not collect unbounded streams or build a cache per operation when shared lifetime is required.
- Wire layers deliberately. Do not merge or expose dependencies merely to silence an environment-type error.

## Verify observable behavior

- Follow the project's test stack. Where `@effect/vitest` is used, prefer `it.effect` for Effect-native tests and `it.live` only when live services are the behavior under test. Do not add `Effect.runSync` merely to adapt an Effect-native unit test.
- Use Clock-backed time in Effect workflows and `TestClock` for virtual-time tests. Fork time-dependent work before advancing the clock. Coordinate readiness with explicit signals rather than arbitrary sleeps.
- Substitute dependencies through layers or explicit adapter seams. Keep mutable scenario state isolated unless shared acquisition is intentional.
- Test domain policy, not Effect internals. Where relevant, verify typed failures, retry eligibility and exhaustion, concurrency bounds, cancellation, and idempotency.
- To prove cleanup, close the owning scope or interrupt and await the owning fiber before asserting release. Retain real-adapter evidence when the claim concerns external cancellation, persistence, or remote effects.
