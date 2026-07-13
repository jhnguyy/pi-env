import type { SpanExporter } from "@opentelemetry/sdk-trace-node";
import { Data, Effect, ManagedRuntime } from "effect";
import {
  type BoundedOtelConfig,
  BoundedOtelConfigError,
  DEFAULT_BOUNDED_OTEL_BOUNDS,
  makeBoundedOtelLayer,
  resolveBoundedOtelConfig,
} from "./otel.js";

export const TOOLING_OTEL_ENV = {
  Enabled: "PI_ENV_TOOLING_OTEL_ENABLED",
  Endpoint: "PI_ENV_TOOLING_OTEL_ENDPOINT",
} as const;

export const TOOLING_OTEL_BOUNDS = DEFAULT_BOUNDED_OTEL_BOUNDS;

export interface ToolingOtelConfig extends BoundedOtelConfig {}

export class ToolingOtelConfigError extends Data.TaggedError("ToolingOtelConfigError")<{
  readonly message: string;
}> {}

export type ToolingAttribute = string | number | boolean;
export type ToolingAttributes = Readonly<Record<string, ToolingAttribute>>;

export const MAX_TOOLING_ATTRIBUTES = 24 as const;
export const MAX_TOOLING_STRING_LENGTH = 128 as const;

const ALLOWED_TOOLING_ATTRIBUTE_KEYS = new Set([
  "operation",
  "mode",
  "template",
  "outcome",
  "error_kind",
  "error_count",
  "warning_count",
  "file_count",
  "finding_count",
  "tool_count",
  "verdict",
  "provider",
  "model",
  "cost_model",
  "job_status",
  "backend",
  "action",
  "method",
]);

const REJECTED_TOOLING_ATTRIBUTE_KEYS = new Set([
  "path",
  "paths",
  "content",
  "diff",
  "prompt",
  "stdout",
  "stderr",
  "endpoint",
  "tokens",
  "input_tokens",
  "output_tokens",
  "cost",
  "costs",
  "secret",
  "secrets",
]);

export function sanitizeToolingAttributes(
  input: Readonly<Record<string, unknown>>,
): ToolingAttributes {
  const output: Record<string, ToolingAttribute> = {};
  for (const [key, value] of Object.entries(input)) {
    if (Object.keys(output).length >= MAX_TOOLING_ATTRIBUTES) break;
    if (REJECTED_TOOLING_ATTRIBUTE_KEYS.has(key)) continue;
    if (!ALLOWED_TOOLING_ATTRIBUTE_KEYS.has(key)) continue;
    if (typeof value === "string") output[key] = value.slice(0, MAX_TOOLING_STRING_LENGTH);
    else if (typeof value === "number" && Number.isFinite(value)) output[key] = value;
    else if (typeof value === "boolean") output[key] = value;
  }
  return output;
}

export interface ToolingDiagnostics {
  readonly span: <A, E, R>(
    name: string,
    attributes: Readonly<Record<string, unknown>>,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly annotate: (attributes: Readonly<Record<string, unknown>>) => Effect.Effect<void>;
}

export const noopToolingDiagnostics: ToolingDiagnostics = {
  span: (_name, _attributes, effect) => effect,
  annotate: () => Effect.void,
};

export function makeEffectToolingDiagnostics(options: {
  readonly telemetryEnabled: boolean;
}): ToolingDiagnostics {
  return {
    span: (name, attributes, effect) =>
      options.telemetryEnabled
        ? effect.pipe(Effect.withSpan(name, { attributes: sanitizeToolingAttributes(attributes) }))
        : effect,
    annotate: (attributes) =>
      options.telemetryEnabled
        ? Effect.annotateCurrentSpan(sanitizeToolingAttributes(attributes)).pipe(Effect.ignore)
        : Effect.void,
  };
}

export function resolveToolingOtelConfig(
  env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<ToolingOtelConfig, ToolingOtelConfigError> {
  return resolveBoundedOtelConfig(env, TOOLING_OTEL_ENV).pipe(
    Effect.mapError(
      (error: BoundedOtelConfigError) => new ToolingOtelConfigError({ message: error.message }),
    ),
  );
}

export function makeToolingOtelLayer(options: {
  readonly config: ToolingOtelConfig;
  readonly serviceName: string;
  readonly serviceVersion?: string;
  readonly exporter?: SpanExporter;
}) {
  return makeBoundedOtelLayer({
    config: options.config,
    exporter: options.exporter,
    bounds: TOOLING_OTEL_BOUNDS,
    serviceName: options.serviceName,
    serviceVersion: options.serviceVersion ?? "0.1.0",
  });
}

export interface ToolingTelemetryRuntime {
  readonly diagnostics: ToolingDiagnostics;
  readonly provide: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
  readonly disposeEffect: Effect.Effect<void>;
}

export function makeToolingTelemetryRuntime(options: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly serviceName: string;
  readonly serviceVersion?: string;
  readonly exporter?: SpanExporter;
}): Effect.Effect<ToolingTelemetryRuntime, ToolingOtelConfigError> {
  return resolveToolingOtelConfig(options.env).pipe(
    Effect.map((config) => {
      if (!config.enabled) {
        return {
          diagnostics: noopToolingDiagnostics,
          provide: <A, E>(effect: Effect.Effect<A, E>) => effect,
          disposeEffect: Effect.void,
        } satisfies ToolingTelemetryRuntime;
      }

      const runtime = ManagedRuntime.make(
        makeToolingOtelLayer({
          config,
          exporter: options.exporter,
          serviceName: options.serviceName,
          serviceVersion: options.serviceVersion,
        }),
      );
      return {
        diagnostics: makeEffectToolingDiagnostics({ telemetryEnabled: true }),
        provide: <A, E>(effect: Effect.Effect<A, E>) =>
          runtime.contextEffect.pipe(Effect.flatMap((context) => Effect.provide(effect, context))),
        disposeEffect: runtime.disposeEffect,
      } satisfies ToolingTelemetryRuntime;
    }),
  );
}
