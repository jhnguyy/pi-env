import { NodeSdk } from "@effect/opentelemetry";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-node";
import { Data, Effect } from "effect";

export const ANALYZE_OTEL_ENV = {
  Enabled: "PI_ENV_ANALYZE_OTEL_ENABLED",
  Endpoint: "PI_ENV_ANALYZE_OTEL_ENDPOINT",
} as const;

export const ANALYZE_OTEL_BOUNDS = {
  maxQueueSize: 64,
  maxExportBatchSize: 16,
  scheduledDelayMillis: 1_000,
  exportTimeoutMillis: 3_000,
  shutdownTimeoutMillis: 3_000,
} as const;

export interface AnalyzeOtelConfig {
  readonly enabled: boolean;
  readonly endpoint?: string;
}

export class AnalyzeOtelConfigError extends Data.TaggedError("AnalyzeOtelConfigError")<{
  readonly message: string;
}> {}

function parseEnabled(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === "") return false;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function normalizeEndpoint(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

export function resolveAnalyzeOtelConfig(
  env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<AnalyzeOtelConfig, AnalyzeOtelConfigError> {
  const enabled = parseEnabled(env[ANALYZE_OTEL_ENV.Enabled]);
  if (enabled === undefined) {
    return Effect.fail(
      new AnalyzeOtelConfigError({
        message: `${ANALYZE_OTEL_ENV.Enabled} must be a boolean value`,
      }),
    );
  }
  if (!enabled) return Effect.succeed({ enabled: false });
  const endpoint = normalizeEndpoint(env[ANALYZE_OTEL_ENV.Endpoint] ?? "");
  if (endpoint === undefined) {
    return Effect.fail(
      new AnalyzeOtelConfigError({
        message: `${ANALYZE_OTEL_ENV.Endpoint} must be an http(s) URL when telemetry is enabled`,
      }),
    );
  }
  return Effect.succeed({ enabled: true, endpoint });
}

function tracesUrl(endpoint: string): string {
  return endpoint.endsWith("/v1/traces") ? endpoint : `${endpoint}/v1/traces`;
}

export function makeAnalyzeOtelLayer(config: AnalyzeOtelConfig, exporter?: SpanExporter) {
  return NodeSdk.layer(() => {
    if (!config.enabled || (config.endpoint === undefined && exporter === undefined)) return {};
    const traceExporter =
      exporter ??
      new OTLPTraceExporter({
        url: tracesUrl(config.endpoint!),
        timeoutMillis: ANALYZE_OTEL_BOUNDS.exportTimeoutMillis,
      });
    return {
      resource: {
        serviceName: "pi-env-analyze",
        serviceVersion: "0.1.0",
        attributes: { "deployment.environment": "local" },
      },
      spanProcessor: new BatchSpanProcessor(traceExporter, {
        maxQueueSize: ANALYZE_OTEL_BOUNDS.maxQueueSize,
        maxExportBatchSize: ANALYZE_OTEL_BOUNDS.maxExportBatchSize,
        scheduledDelayMillis: ANALYZE_OTEL_BOUNDS.scheduledDelayMillis,
        exportTimeoutMillis: ANALYZE_OTEL_BOUNDS.exportTimeoutMillis,
      }),
      shutdownTimeout: ANALYZE_OTEL_BOUNDS.shutdownTimeoutMillis,
    };
  });
}
