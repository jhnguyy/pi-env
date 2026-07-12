import { Duration, Effect, Metric } from "effect";
import type { AnalyzerName, ScopeMode } from "./model.js";

export const ANALYZE_DIAGNOSTIC_VERSION = 1 as const;

export const AnalyzeSpanName = {
  Run: "analyze.run",
  ContainmentPrepare: "analyze.containment.prepare",
  Worker: "analyze.worker",
  Preflight: "analyze.preflight",
  Scope: "analyze.scope",
  ProjectLoad: "analyze.project.load",
  Check: "analyze.check",
  Subprocess: "analyze.subprocess",
  Parse: "analyze.parse",
  Result: "analyze.result",
} as const;
export type AnalyzeSpanName = (typeof AnalyzeSpanName)[keyof typeof AnalyzeSpanName];

export const AnalyzeDiagnosticEventType = {
  RunStarted: "run-started",
  StageStarted: "stage-started",
  StageCompleted: "stage-completed",
  MemorySample: "memory-sample",
  Failure: "failure",
  RunCompleted: "run-completed",
  RunTerminated: "run-terminated",
} as const;
export type AnalyzeDiagnosticEventType =
  (typeof AnalyzeDiagnosticEventType)[keyof typeof AnalyzeDiagnosticEventType];

export const AnalyzeOutcome = {
  Success: "success",
  Failure: "failure",
  Interrupted: "interrupted",
} as const;
export type AnalyzeOutcome = (typeof AnalyzeOutcome)[keyof typeof AnalyzeOutcome];

export const AnalyzeTerminationReason = {
  Completed: "completed",
  Configuration: "configuration",
  Scope: "scope",
  Program: "program",
  Analyzer: "analyzer",
  Timeout: "timeout",
  Cancelled: "cancelled",
  Oom: "oom",
  OutputLimit: "output-limit",
  Protocol: "protocol",
  Unknown: "unknown",
} as const;
export type AnalyzeTerminationReason =
  (typeof AnalyzeTerminationReason)[keyof typeof AnalyzeTerminationReason];

export type DiagnosticAttribute = string | number | boolean;
export type DiagnosticAttributes = Readonly<Record<string, DiagnosticAttribute>>;

const ALLOWED_ATTRIBUTE_KEYS = new Set([
  "analyzer",
  "cgroup_oom_count",
  "check_count",
  "duration_ms",
  "exit_code",
  "external_mib",
  "failure_count",
  "file_count",
  "finding_count",
  "heap_mib",
  "max_memory_mb",
  "outcome",
  "process_count",
  "project_requirement",
  "rss_mib",
  "scope_mode",
  "signal",
  "stage",
  "termination_reason",
  "timeout_ms",
]);

export const MAX_DIAGNOSTIC_ATTRIBUTES = 24 as const;
export const MAX_DIAGNOSTIC_STRING_LENGTH = 128 as const;

export interface AnalysisDiagnosticEvent {
  readonly version: typeof ANALYZE_DIAGNOSTIC_VERSION;
  readonly runId: string;
  readonly timestampMs: number;
  readonly type: AnalyzeDiagnosticEventType;
  readonly attributes: DiagnosticAttributes;
  readonly terminal: boolean;
}

export function sanitizeDiagnosticAttributes(
  input: Readonly<Record<string, unknown>>,
): DiagnosticAttributes {
  const output: Record<string, DiagnosticAttribute> = {};
  for (const [key, value] of Object.entries(input)) {
    if (Object.keys(output).length >= MAX_DIAGNOSTIC_ATTRIBUTES) break;
    if (!ALLOWED_ATTRIBUTE_KEYS.has(key)) continue;
    if (typeof value === "string") output[key] = value.slice(0, MAX_DIAGNOSTIC_STRING_LENGTH);
    else if (typeof value === "number" && Number.isFinite(value)) output[key] = value;
    else if (typeof value === "boolean") output[key] = value;
  }
  return output;
}

export function makeDiagnosticEvent(
  runId: string,
  timestampMs: number,
  type: AnalyzeDiagnosticEventType,
  attributes: Readonly<Record<string, unknown>> = {},
): AnalysisDiagnosticEvent {
  return {
    version: ANALYZE_DIAGNOSTIC_VERSION,
    runId: runId.slice(0, MAX_DIAGNOSTIC_STRING_LENGTH),
    timestampMs,
    type,
    attributes: sanitizeDiagnosticAttributes(attributes),
    terminal:
      type === AnalyzeDiagnosticEventType.RunCompleted ||
      type === AnalyzeDiagnosticEventType.RunTerminated,
  };
}

export interface AnalysisDiagnostics {
  readonly span: <A, E, R>(
    name: AnalyzeSpanName,
    attributes: Readonly<Record<string, unknown>>,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly record: (event: AnalysisDiagnosticEvent) => Effect.Effect<void>;
}

export const noopAnalysisDiagnostics: AnalysisDiagnostics = {
  span: (_name, _attributes, effect) => effect,
  record: () => Effect.void,
};

export type DiagnosticEventSink = (event: AnalysisDiagnosticEvent) => Effect.Effect<void>;

const runCounter = Metric.counter("pi_env_analyze_runs_total", { incremental: true });
const failureCounter = Metric.counter("pi_env_analyze_failures_total", { incremental: true });
const runDuration = Metric.timer("pi_env_analyze_run_duration", "Analyze run duration");
const stageDuration = Metric.timer("pi_env_analyze_stage_duration", "Analyze stage duration");
const currentRss = Metric.gauge("pi_env_analyze_rss_mib");
const currentHeap = Metric.gauge("pi_env_analyze_heap_mib");
const currentExternal = Metric.gauge("pi_env_analyze_external_mib");

function metricEffects(event: AnalysisDiagnosticEvent): Effect.Effect<void> {
  const attributes = event.attributes;
  switch (event.type) {
    case AnalyzeDiagnosticEventType.RunStarted:
      return Metric.increment(
        Metric.tagged(runCounter, "scope_mode", String(attributes.scope_mode ?? "unknown")),
      );
    case AnalyzeDiagnosticEventType.Failure:
    case AnalyzeDiagnosticEventType.RunTerminated:
      return Metric.increment(
        Metric.tagged(
          failureCounter,
          "termination_reason",
          String(attributes.termination_reason ?? "unknown"),
        ),
      );
    case AnalyzeDiagnosticEventType.RunCompleted:
      return typeof attributes.duration_ms === "number"
        ? Metric.update(runDuration, Duration.millis(attributes.duration_ms))
        : Effect.void;
    case AnalyzeDiagnosticEventType.StageCompleted:
      return typeof attributes.duration_ms === "number"
        ? Metric.update(
            Metric.tagged(stageDuration, "stage", String(attributes.stage ?? "unknown")),
            Duration.millis(attributes.duration_ms),
          )
        : Effect.void;
    case AnalyzeDiagnosticEventType.MemorySample: {
      const updates: Effect.Effect<void>[] = [];
      if (typeof attributes.rss_mib === "number")
        updates.push(Metric.set(currentRss, attributes.rss_mib));
      if (typeof attributes.heap_mib === "number")
        updates.push(Metric.set(currentHeap, attributes.heap_mib));
      if (typeof attributes.external_mib === "number")
        updates.push(Metric.set(currentExternal, attributes.external_mib));
      return Effect.all(updates, { discard: true });
    }
    case AnalyzeDiagnosticEventType.StageStarted:
      return Effect.void;
  }
}

function logEvent(event: AnalysisDiagnosticEvent): Effect.Effect<void> {
  const message = `analyze.${event.type}`;
  const annotations = { run_id: event.runId, ...event.attributes };
  const log =
    event.type === AnalyzeDiagnosticEventType.Failure ||
    event.type === AnalyzeDiagnosticEventType.RunTerminated
      ? Effect.logWarning(message)
      : event.type === AnalyzeDiagnosticEventType.RunCompleted
        ? Effect.logInfo(message)
        : Effect.logDebug(message);
  return log.pipe(Effect.annotateLogs(annotations));
}

export function makeEffectAnalysisDiagnostics(options: {
  readonly telemetryEnabled: boolean;
  readonly sink?: DiagnosticEventSink;
}): AnalysisDiagnostics {
  const sink = options.sink;
  return {
    span: (name, attributes, effect) =>
      options.telemetryEnabled
        ? effect.pipe(
            Effect.withSpan(name, { attributes: sanitizeDiagnosticAttributes(attributes) }),
          )
        : effect,
    record: (event) => {
      const effects: Effect.Effect<void>[] = [];
      if (options.telemetryEnabled) {
        effects.push(
          Effect.annotateCurrentSpan({ run_id: event.runId, ...event.attributes }).pipe(
            Effect.ignore,
          ),
          metricEffects(event),
          logEvent(event),
        );
      }
      if (sink !== undefined) effects.push(sink(event).pipe(Effect.ignore));
      return Effect.all(effects, { discard: true });
    },
  };
}

export function analysisRunAttributes(options: {
  readonly scope: ScopeMode;
  readonly checks?: readonly string[];
  readonly maxMemoryMb?: number;
  readonly externalTimeoutMs?: number;
}): DiagnosticAttributes {
  return sanitizeDiagnosticAttributes({
    scope_mode: options.scope,
    check_count: options.checks?.length,
    max_memory_mb: options.maxMemoryMb,
    timeout_ms: options.externalTimeoutMs,
  });
}

export function analyzerAttributes(
  analyzer: AnalyzerName,
  extra: Readonly<Record<string, unknown>> = {},
): DiagnosticAttributes {
  return sanitizeDiagnosticAttributes({ analyzer, ...extra });
}
