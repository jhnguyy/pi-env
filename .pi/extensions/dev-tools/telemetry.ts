import { AsyncLocalStorage } from "node:async_hooks";
import { Effect, Result, type Tracer } from "effect";

import type { ToolingDiagnostics } from "../../../src/telemetry/tooling.js";

export const DevToolsSpanName = {
  BackendStartup: "tooling.dev-tools.backend.startup",
  BackendInitialize: "tooling.dev-tools.backend.initialize",
  BackendRequest: "tooling.dev-tools.backend.request",
  BackendShutdown: "tooling.dev-tools.backend.shutdown",
  DaemonRequest: "tooling.dev-tools.daemon.request",
} as const;
export type DevToolsSpanName = (typeof DevToolsSpanName)[keyof typeof DevToolsSpanName];

const parentSpanStorage = new AsyncLocalStorage<Tracer.AnySpan>();

/** Bridge the daemon request span across Promise-based handler compatibility callbacks. */
export function runWithDevToolsParentSpan<A>(
  parent: Tracer.AnySpan,
  run: () => Promise<A>,
): Promise<A> {
  return parentSpanStorage.run(parent, run);
}

/** Restore a daemon request parent when a backend starts a new Effect runtime fiber. */
export function inheritDevToolsParentSpan<A, E>(
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, E> {
  const parent = parentSpanStorage.getStore();
  return parent ? effect.pipe(Effect.withParentSpan(parent)) : effect;
}

/** Record only sanitized outcome metadata inside the span, then restore the typed failure outside it. */
export function withSafeDevToolsSpan<A, E>(
  diagnostics: ToolingDiagnostics,
  name: DevToolsSpanName,
  attributes: Readonly<Record<string, unknown>>,
  effect: Effect.Effect<A, E>,
  errorKind: (error: E) => string,
): Effect.Effect<A, E> {
  const observed = diagnostics.span(
    name,
    attributes,
    effect.pipe(
      Effect.result,
      Effect.tap((result) =>
        diagnostics.annotate(
          Result.isFailure(result)
            ? { outcome: "failure", error_kind: errorKind(result.failure) }
            : { outcome: "success" },
        ),
      ),
    ),
  );
  return observed.pipe(
    Effect.flatMap((result) =>
      Result.isFailure(result) ? Effect.fail(result.failure) : Effect.succeed(result.success),
    ),
  );
}
