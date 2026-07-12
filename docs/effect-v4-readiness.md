# Effect v4 readiness

Effect v4 is currently beta. pi-env is preparing for it without weakening dependency trust, changing public Promise/Pi adapters, or destabilizing lifecycle and containment boundaries.

## Current decision

Do not install the v4 beta yet.

A local dependency-only spike against `4.0.0-beta.97` on 2026-07-12 stopped before resolution: Nub's `trustPolicy=no-downgrade` reported that the beta releases of `effect`, `@effect/platform-node`, and `@effect/opentelemetry` used provenance attestations after earlier trusted-publisher releases. This is evaluation evidence rather than a permanent claim about later betas. The repository will not add trust exclusions or disable this policy to force adoption.

Re-evaluate when the complete required package line satisfies the existing trust policy. Pin the same exact v4 version across Effect ecosystem packages during beta; do not use a caret range.

## Package topology

The current runtime is one shared Effect v3 graph:

- `effect`
- `@effect/platform`
- `@effect/platform-node`
- `@effect/opentelemetry`
- `@effect/language-service` for authored TypeScript diagnostics

In v4, platform abstractions move into `effect`; the standalone `@effect/platform` dependency should be removed. Platform-specific Node and OpenTelemetry packages remain separate and must match the core version. Extension bundles externalize Effect, so this is a repository-wide runtime migration rather than an extension-by-extension dependency upgrade.

## Migration order

After the dependency gate clears:

1. **Dependency-only resolution** — exact matching versions, one installed Effect major, no trust-policy changes.
2. **Leaf schemas and adapters** — settings and web-context boundaries while preserving their current sync/Promise wrappers.
3. **Core renames** — `Result` for `Either`, `Effect.result` for `Effect.either`, `Effect.callback` for `Effect.async`, `Effect.catch` for `Effect.catchAll`, and `Context.Service` for tags.
4. **Schema rewrite** — migrate variadic literals/unions, record forms, decode APIs, filters, and schema type extraction at consumer boundaries.
5. **Process and Analyze internals** — revalidate interruption, timeout, output bounds, detached process groups, and fail-closed policy before changing runtime ownership.
6. **Telemetry** — migrate the bounded Node SDK layer only after the core Analyze worker remains safe with telemetry disabled.
7. **Subagent lifecycle** — migrate scoped fibers, deferreds, queues, cancellation, and shutdown last because this is the richest lifecycle seam.

Do not introduce a parallel compatibility runtime or couple extensions through another extension's private state.

## Readiness enforcement

`nub run check:effect-v4` counts selected, confirmed v3-only API shapes in tracked TypeScript/JavaScript under `.pi/extensions`, `src`, `scripts`, `setup`, and `.agents`. It follows named root-import aliases, rejects untracked import shapes for guarded modules, and ignores generated `dist` files. The checked-in baseline is exact:

- adding migration debt fails;
- removing migration debt fails until the baseline is lowered in the same change;
- unchanged source passes.

This is a bounded monotonic migration aid, not a complete v4 compatibility audit or a substitute for the compiler. Update the rule set only for confirmed v4 changes used by this repository.

## Go gates

A migration branch must pass, independently:

- frozen dependency install under the unchanged trust policy;
- typecheck with Effect language-service diagnostics enabled;
- extension build and install readiness;
- unit and setup portfolios;
- process descendant cleanup, timeout, output-cap, and interruption tests;
- Analyze policy and supervisor safety tests;
- bounded Analyze complexity canary;
- telemetry-disabled behavior, followed by bounded telemetry-enabled behavior.

Heavy and whole-project Analyze remain fail-closed throughout the migration.
