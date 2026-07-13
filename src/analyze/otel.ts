import type { SpanExporter } from "@opentelemetry/sdk-trace-node";
import { Data, Effect } from "effect";
import {
  type BoundedOtelConfig,
  BoundedOtelConfigError,
  DEFAULT_BOUNDED_OTEL_BOUNDS,
  makeBoundedOtelLayer,
  resolveBoundedOtelConfig,
} from "../telemetry/otel.js";

export const ANALYZE_OTEL_ENV = {
  Enabled: "PI_ENV_ANALYZE_OTEL_ENABLED",
  Endpoint: "PI_ENV_ANALYZE_OTEL_ENDPOINT",
} as const;

export const ANALYZE_OTEL_BOUNDS = DEFAULT_BOUNDED_OTEL_BOUNDS;

export interface AnalyzeOtelConfig extends BoundedOtelConfig {}

export class AnalyzeOtelConfigError extends Data.TaggedError("AnalyzeOtelConfigError")<{
  readonly message: string;
}> {}

export function resolveAnalyzeOtelConfig(
  env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<AnalyzeOtelConfig, AnalyzeOtelConfigError> {
  return resolveBoundedOtelConfig(env, ANALYZE_OTEL_ENV).pipe(
    Effect.mapError(
      (error: BoundedOtelConfigError) => new AnalyzeOtelConfigError({ message: error.message }),
    ),
  );
}

export function makeAnalyzeOtelLayer(config: AnalyzeOtelConfig, exporter?: SpanExporter) {
  return makeBoundedOtelLayer({
    config,
    exporter,
    bounds: ANALYZE_OTEL_BOUNDS,
    serviceName: "pi-env-analyze",
    serviceVersion: "0.1.0",
  });
}
