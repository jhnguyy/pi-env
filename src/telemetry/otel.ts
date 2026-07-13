import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-node";
import { Data, Effect } from "effect";

export interface BoundedOtelEnv {
  readonly Enabled: string;
  readonly Endpoint: string;
}

export interface BoundedOtelBounds {
  readonly maxQueueSize: number;
  readonly maxExportBatchSize: number;
  readonly scheduledDelayMillis: number;
  readonly exportTimeoutMillis: number;
  readonly shutdownTimeoutMillis: number;
}

export interface BoundedOtelConfig {
  readonly enabled: boolean;
  readonly endpoint?: string;
}

export const DEFAULT_BOUNDED_OTEL_BOUNDS = {
  maxQueueSize: 64,
  maxExportBatchSize: 16,
  scheduledDelayMillis: 1_000,
  exportTimeoutMillis: 3_000,
  shutdownTimeoutMillis: 3_000,
} as const;

export class BoundedOtelConfigError extends Data.TaggedError("BoundedOtelConfigError")<{
  readonly message: string;
}> {}

export function parseBoundedOtelEnabled(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === "") return false;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

export function normalizeBoundedOtelEndpoint(value: string): string | undefined {
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

export function resolveBoundedOtelConfig(
  env: Readonly<Record<string, string | undefined>>,
  keys: BoundedOtelEnv,
): Effect.Effect<BoundedOtelConfig, BoundedOtelConfigError> {
  const enabled = parseBoundedOtelEnabled(env[keys.Enabled]);
  if (enabled === undefined) {
    return Effect.fail(
      new BoundedOtelConfigError({ message: `${keys.Enabled} must be a boolean value` }),
    );
  }
  if (!enabled) return Effect.succeed({ enabled: false });
  const endpoint = normalizeBoundedOtelEndpoint(env[keys.Endpoint] ?? "");
  if (endpoint === undefined) {
    return Effect.fail(
      new BoundedOtelConfigError({
        message: `${keys.Endpoint} must be an http(s) URL when telemetry is enabled`,
      }),
    );
  }
  return Effect.succeed({ enabled: true, endpoint });
}

export function boundedOtelTracesUrl(endpoint: string): string {
  return endpoint.endsWith("/v1/traces") ? endpoint : `${endpoint}/v1/traces`;
}

export function makeBoundedOtelLayer(options: {
  readonly config: BoundedOtelConfig;
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly bounds: BoundedOtelBounds;
  readonly exporter?: SpanExporter;
  readonly resourceAttributes?: Readonly<Record<string, string | number | boolean>>;
}) {
  return NodeSdk.layer(() => {
    const { config, bounds, exporter } = options;
    if (!config.enabled || (config.endpoint === undefined && exporter === undefined)) return {};
    const traceExporter =
      exporter ??
      new OTLPTraceExporter({
        url: boundedOtelTracesUrl(config.endpoint!),
        timeoutMillis: bounds.exportTimeoutMillis,
      });
    return {
      resource: {
        serviceName: options.serviceName,
        serviceVersion: options.serviceVersion,
        attributes: {
          "deployment.environment": "local",
          ...options.resourceAttributes,
        },
      },
      spanProcessor: new BatchSpanProcessor(traceExporter, {
        maxQueueSize: bounds.maxQueueSize,
        maxExportBatchSize: bounds.maxExportBatchSize,
        scheduledDelayMillis: bounds.scheduledDelayMillis,
        exportTimeoutMillis: bounds.exportTimeoutMillis,
      }),
      shutdownTimeout: bounds.shutdownTimeoutMillis,
    };
  });
}
