import { isAbsolute } from "node:path";
import { Data, Effect, Schema } from "effect";
import {
  AnalyzerName,
  FindingKind,
  ScopeMode,
  Severity,
  type AnalysisResult,
  type AnalyzerFailure,
  type Finding,
  type Location,
} from "./model.js";
import {
  ANALYZE_DIAGNOSTIC_VERSION,
  AnalyzeDiagnosticEventType,
  makeDiagnosticEvent,
  type AnalysisDiagnosticEvent,
} from "./diagnostics.js";
import {
  ANALYZE_LIMITS,
  SAFE_CHECKS,
  isBoundedWorkspaceRelativePath,
  type SafeAnalyzerName,
} from "./policy.js";

export const ANALYZE_WORKER_PROTOCOL_VERSION = 1 as const;
export const MAX_PROTOCOL_LINE_BYTES = 64 * 1024;
export const MAX_PROTOCOL_TOTAL_BYTES = ANALYZE_LIMITS.stdoutBytes;

export const AnalyzeWorkerMessageType = {
  Request: "request",
  Started: "started",
  Diagnostic: "diagnostic",
  Result: "result",
  Complete: "complete",
} as const;
export type AnalyzeWorkerMessageType =
  (typeof AnalyzeWorkerMessageType)[keyof typeof AnalyzeWorkerMessageType];

export interface AnalyzeWorkerRequest {
  readonly version: typeof ANALYZE_WORKER_PROTOCOL_VERSION;
  readonly type: typeof AnalyzeWorkerMessageType.Request;
  readonly runId: string;
  readonly cwd: string;
  readonly scope: typeof ScopeMode.Diff | typeof ScopeMode.Paths;
  readonly paths?: readonly string[];
  readonly ref?: string;
  readonly checks: readonly SafeAnalyzerName[];
  readonly maxMemoryMb: typeof ANALYZE_LIMITS.maxMemoryMb;
  readonly maxSourceFiles: typeof ANALYZE_LIMITS.sourceFiles;
  readonly maxSourceFileBytes: typeof ANALYZE_LIMITS.sourceFileBytes;
  readonly maxSourceBytes: typeof ANALYZE_LIMITS.sourceBytes;
  readonly timeoutMs: number;
}

export interface AnalyzeWorkerStarted {
  readonly version: typeof ANALYZE_WORKER_PROTOCOL_VERSION;
  readonly type: typeof AnalyzeWorkerMessageType.Started;
  readonly runId: string;
}

export interface AnalyzeWorkerDiagnostic {
  readonly version: typeof ANALYZE_WORKER_PROTOCOL_VERSION;
  readonly type: typeof AnalyzeWorkerMessageType.Diagnostic;
  readonly runId: string;
  readonly event: AnalysisDiagnosticEvent;
}

export interface AnalyzeWorkerResult {
  readonly version: typeof ANALYZE_WORKER_PROTOCOL_VERSION;
  readonly type: typeof AnalyzeWorkerMessageType.Result;
  readonly runId: string;
  readonly result: AnalysisResult;
}

export interface AnalyzeWorkerComplete {
  readonly version: typeof ANALYZE_WORKER_PROTOCOL_VERSION;
  readonly type: typeof AnalyzeWorkerMessageType.Complete;
  readonly runId: string;
}

export type AnalyzeWorkerEvent =
  | AnalyzeWorkerStarted
  | AnalyzeWorkerDiagnostic
  | AnalyzeWorkerResult
  | AnalyzeWorkerComplete;

export const AnalyzeProtocolErrorKind = {
  Malformed: "malformed",
  Version: "version",
  LineLimit: "line-limit",
  TotalLimit: "total-limit",
  State: "state",
} as const;
export type AnalyzeProtocolErrorKind =
  (typeof AnalyzeProtocolErrorKind)[keyof typeof AnalyzeProtocolErrorKind];

export class AnalyzeProtocolError extends Data.TaggedError("AnalyzeProtocolError")<{
  readonly kind: AnalyzeProtocolErrorKind;
  readonly message: string;
}> {}

const AnalyzeWorkerLocationSchema = Schema.Struct({
  path: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
  endLine: Schema.optionalKey(Schema.Number),
  endColumn: Schema.optionalKey(Schema.Number),
});

const AnalyzeWorkerFindingSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  analyzer: Schema.String,
  kind: Schema.String,
  severity: Schema.String,
  message: Schema.String,
  location: AnalyzeWorkerLocationSchema,
  related: Schema.optionalKey(Schema.Array(AnalyzeWorkerLocationSchema)),
});

const AnalyzeWorkerFailureSchema = Schema.Struct({
  analyzer: Schema.String,
  message: Schema.String,
});

export const AnalyzeWorkerResultPayloadSchema = Schema.Struct({
  version: Schema.Number,
  summary: Schema.Struct({
    info: Schema.Number,
    warning: Schema.Number,
    error: Schema.Number,
    failures: Schema.Number,
  }),
  findings: Schema.Array(AnalyzeWorkerFindingSchema),
  analyzerFailures: Schema.Array(AnalyzeWorkerFailureSchema),
  benchmarks: Schema.Array(Schema.Unknown),
  profile: Schema.optionalKey(Schema.Unknown),
});

type AnalyzeWorkerResultPayload = (typeof AnalyzeWorkerResultPayloadSchema)["Type"];
type AnalyzeWorkerLocation = (typeof AnalyzeWorkerLocationSchema)["Type"];
type AnalyzeWorkerFinding = (typeof AnalyzeWorkerFindingSchema)["Type"];
type AnalyzeWorkerFailure = (typeof AnalyzeWorkerFailureSchema)["Type"];

const protocolFailure = (
  kind: AnalyzeProtocolErrorKind,
  message: string,
): Effect.Effect<never, AnalyzeProtocolError> =>
  Effect.fail(new AnalyzeProtocolError({ kind, message }));

function isBoundedString(value: unknown, max: number, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    value.length <= max &&
    !value.includes("\0")
  );
}

function parseObjectLine(
  line: string,
): Effect.Effect<Record<string, unknown>, AnalyzeProtocolError> {
  if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
    return protocolFailure(
      AnalyzeProtocolErrorKind.LineLimit,
      "Analyze worker protocol line exceeded its byte limit",
    );
  }
  return Effect.try({
    try: () => JSON.parse(line) as unknown,
    catch: () =>
      new AnalyzeProtocolError({
        kind: AnalyzeProtocolErrorKind.Malformed,
        message: "Analyze worker protocol line is not valid JSON",
      }),
  }).pipe(
    Effect.flatMap((value) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Effect.succeed(value as Record<string, unknown>)
        : protocolFailure(
            AnalyzeProtocolErrorKind.Malformed,
            "Analyze worker protocol line must contain an object",
          ),
    ),
  );
}

function validateEnvelope(
  value: Record<string, unknown>,
  expectedType?: AnalyzeWorkerMessageType,
): Effect.Effect<string, AnalyzeProtocolError> {
  if (value.version !== ANALYZE_WORKER_PROTOCOL_VERSION) {
    return protocolFailure(
      AnalyzeProtocolErrorKind.Version,
      "Unsupported analyze worker protocol version",
    );
  }
  if (
    typeof value.type !== "string" ||
    !Object.values(AnalyzeWorkerMessageType).includes(value.type as AnalyzeWorkerMessageType) ||
    (expectedType !== undefined && value.type !== expectedType)
  ) {
    return protocolFailure(
      AnalyzeProtocolErrorKind.Malformed,
      "Analyze worker message type is invalid",
    );
  }
  if (!isBoundedString(value.runId, 128)) {
    return protocolFailure(AnalyzeProtocolErrorKind.Malformed, "Analyze worker runId is invalid");
  }
  return Effect.succeed(value.runId);
}

function validRequestRoot(value: Record<string, unknown>): boolean {
  return (
    isBoundedString(value.cwd, ANALYZE_LIMITS.cwdLength) &&
    isAbsolute(value.cwd) &&
    (value.scope === ScopeMode.Diff || value.scope === ScopeMode.Paths)
  );
}

function validRequestChecks(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= SAFE_CHECKS.length &&
    new Set(value).size === value.length &&
    value.every((check) => SAFE_CHECKS.includes(check as SafeAnalyzerName))
  );
}

function validRequestLimits(value: Record<string, unknown>): boolean {
  return (
    value.maxMemoryMb === ANALYZE_LIMITS.maxMemoryMb &&
    value.maxSourceFiles === ANALYZE_LIMITS.sourceFiles &&
    value.maxSourceFileBytes === ANALYZE_LIMITS.sourceFileBytes &&
    value.maxSourceBytes === ANALYZE_LIMITS.sourceBytes &&
    Number.isInteger(value.timeoutMs) &&
    (value.timeoutMs as number) >= 1_000 &&
    (value.timeoutMs as number) <= ANALYZE_LIMITS.timeoutMs
  );
}

function validRequestPaths(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= ANALYZE_LIMITS.paths &&
    new Set(value).size === value.length &&
    value.every((path) => typeof path === "string" && isBoundedWorkspaceRelativePath(path))
  );
}

function requestScopeMatchesPaths(value: Record<string, unknown>): boolean {
  return value.scope === ScopeMode.Paths ? value.paths !== undefined : value.paths === undefined;
}

function validRequestRef(value: unknown): boolean {
  return (
    value === undefined ||
    (isBoundedString(value, ANALYZE_LIMITS.refLength) && !value.startsWith("-"))
  );
}

export function parseAnalyzeWorkerRequest(
  line: string,
): Effect.Effect<AnalyzeWorkerRequest, AnalyzeProtocolError> {
  return Effect.gen(function* () {
    const value = yield* parseObjectLine(line);
    yield* validateEnvelope(value, AnalyzeWorkerMessageType.Request);
    if (!validRequestRoot(value)) {
      return yield* protocolFailure(
        AnalyzeProtocolErrorKind.Malformed,
        "Analyze worker request scope or cwd is invalid",
      );
    }
    if (!validRequestChecks(value.checks)) {
      return yield* protocolFailure(
        AnalyzeProtocolErrorKind.Malformed,
        "Analyze worker request checks are invalid",
      );
    }
    if (!validRequestLimits(value)) {
      return yield* protocolFailure(
        AnalyzeProtocolErrorKind.Malformed,
        "Analyze worker request limits are invalid",
      );
    }
    if (!validRequestPaths(value.paths)) {
      return yield* protocolFailure(
        AnalyzeProtocolErrorKind.Malformed,
        "Analyze worker request paths are invalid",
      );
    }
    if (!requestScopeMatchesPaths(value)) {
      return yield* protocolFailure(
        AnalyzeProtocolErrorKind.Malformed,
        "Analyze worker request scope and paths disagree",
      );
    }
    if (!validRequestRef(value.ref)) {
      return yield* protocolFailure(
        AnalyzeProtocolErrorKind.Malformed,
        "Analyze worker request ref is invalid",
      );
    }
    return value as unknown as AnalyzeWorkerRequest;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: number | undefined): value is number {
  return Number.isInteger(value) && value !== undefined && value >= 1;
}

function validOptionalPositiveInteger(value: number | undefined): boolean {
  return value === undefined || isPositiveInteger(value);
}

function parseLocation(value: AnalyzeWorkerLocation): Location | undefined {
  if (!isBoundedString(value.path, ANALYZE_LIMITS.pathLength)) return undefined;
  if (!isBoundedWorkspaceRelativePath(value.path)) return undefined;
  if (!isPositiveInteger(value.line) || !isPositiveInteger(value.column)) return undefined;
  if (!validOptionalPositiveInteger(value.endLine)) return undefined;
  if (!validOptionalPositiveInteger(value.endColumn)) return undefined;
  return {
    path: value.path,
    line: value.line,
    column: value.column,
    ...(value.endLine === undefined ? {} : { endLine: value.endLine }),
    ...(value.endColumn === undefined ? {} : { endColumn: value.endColumn }),
  };
}

function parseRelatedLocations(
  value: readonly AnalyzeWorkerLocation[] | undefined,
): Location[] | undefined {
  if (value === undefined) return [];
  if (value.length > ANALYZE_LIMITS.relatedLocations) return undefined;
  const related: Location[] = [];
  for (const item of value) {
    const parsed = parseLocation(item);
    if (!parsed) return undefined;
    related.push(parsed);
  }
  return related;
}

function validFindingHeader(finding: AnalyzeWorkerFinding): boolean {
  return (
    Object.values(AnalyzerName).includes(finding.analyzer as AnalyzerName) &&
    Object.values(FindingKind).includes(finding.kind as FindingKind) &&
    Object.values(Severity).includes(finding.severity as Severity) &&
    isBoundedString(finding.message, ANALYZE_LIMITS.messageLength) &&
    (finding.id === undefined || isBoundedString(finding.id, 128, true))
  );
}

function parseFinding(value: AnalyzeWorkerFinding): Finding | undefined {
  if (!validFindingHeader(value)) return undefined;
  const location = parseLocation(value.location);
  const related = parseRelatedLocations(value.related);
  if (!location || related === undefined) return undefined;
  return {
    id: value.id ?? "",
    analyzer: value.analyzer as AnalyzerName,
    kind: value.kind as FindingKind,
    severity: value.severity as Severity,
    message: value.message,
    location,
    ...(value.related === undefined ? {} : { related }),
  };
}

const allowedFailureAnalyzers = new Set<AnalyzerFailure["analyzer"]>([
  ...Object.values(AnalyzerName),
  "benchmark",
  "configuration",
  "containment",
  "scope",
  "program",
  "supervisor",
]);

function parseFailure(value: AnalyzeWorkerFailure): AnalyzerFailure | undefined {
  if (!allowedFailureAnalyzers.has(value.analyzer as AnalyzerFailure["analyzer"])) {
    return undefined;
  }
  if (!isBoundedString(value.message, 1_024)) return undefined;
  return {
    analyzer: value.analyzer as AnalyzerFailure["analyzer"],
    message: value.message,
  };
}

function parseBoundedArray<Input, Output>(
  value: readonly Input[],
  max: number,
  parse: (item: Input) => Output | undefined,
): Output[] | undefined {
  if (value.length > max) return undefined;
  const output: Output[] = [];
  for (const item of value) {
    const parsed = parse(item);
    if (parsed === undefined) return undefined;
    output.push(parsed);
  }
  return output;
}

function parseSummary(
  value: AnalyzeWorkerResultPayload["summary"],
): AnalysisResult["summary"] | undefined {
  const counts = [value.info, value.warning, value.error, value.failures];
  if (counts.some((count) => !Number.isInteger(count) || count < 0 || count > 1_000_000)) {
    return undefined;
  }
  return {
    info: value.info,
    warning: value.warning,
    error: value.error,
    failures: value.failures,
  };
}

function trustedSummaryFor(
  findings: readonly Finding[],
  failures: readonly AnalyzerFailure[],
): AnalysisResult["summary"] {
  return {
    info: findings.filter((finding) => finding.severity === Severity.Info).length,
    warning: findings.filter((finding) => finding.severity === Severity.Warning).length,
    error: findings.filter((finding) => finding.severity === Severity.Error).length,
    failures: failures.length,
  };
}

function summariesMatch(
  received: AnalysisResult["summary"],
  trusted: AnalysisResult["summary"],
): boolean {
  return (
    received.info === trusted.info &&
    received.warning === trusted.warning &&
    received.error === trusted.error &&
    received.failures === trusted.failures
  );
}

function validResultEnvelope(result: AnalyzeWorkerResultPayload): boolean {
  return result.version === 1 && result.benchmarks.length === 0 && result.profile === undefined;
}

const invalidAnalysisResult = (): Effect.Effect<never, AnalyzeProtocolError> =>
  protocolFailure(AnalyzeProtocolErrorKind.Malformed, "Analyze worker result is invalid");

function parseAnalysisResult(value: unknown): Effect.Effect<AnalysisResult, AnalyzeProtocolError> {
  return Effect.gen(function* () {
    const result = yield* Schema.decodeUnknownEffect(AnalyzeWorkerResultPayloadSchema)(value).pipe(
      Effect.catch(invalidAnalysisResult),
    );
    const summary = parseSummary(result.summary);
    const findings = parseBoundedArray(result.findings, ANALYZE_LIMITS.findings, parseFinding);
    const analyzerFailures = parseBoundedArray(
      result.analyzerFailures,
      ANALYZE_LIMITS.failures,
      parseFailure,
    );
    if (!validResultEnvelope(result) || !summary || !findings || !analyzerFailures) {
      return yield* invalidAnalysisResult();
    }
    const trustedSummary = trustedSummaryFor(findings, analyzerFailures);
    if (!summariesMatch(summary, trustedSummary)) {
      return yield* invalidAnalysisResult();
    }
    const trusted: AnalysisResult = {
      version: 1,
      summary: trustedSummary,
      findings,
      analyzerFailures,
      benchmarks: [],
    };
    if (Buffer.byteLength(JSON.stringify(trusted), "utf8") > ANALYZE_LIMITS.resultBytes) {
      return yield* invalidAnalysisResult();
    }
    return trusted;
  });
}

const allowedWorkerDiagnosticTypes = new Set<AnalyzeDiagnosticEventType>([
  AnalyzeDiagnosticEventType.StageStarted,
  AnalyzeDiagnosticEventType.StageCompleted,
  AnalyzeDiagnosticEventType.MemorySample,
  AnalyzeDiagnosticEventType.Failure,
]);

function parseWorkerDiagnostic(value: unknown, runId: string): AnalysisDiagnosticEvent | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const event = value as Record<string, unknown>;
  if (
    event.version !== ANALYZE_DIAGNOSTIC_VERSION ||
    event.runId !== runId ||
    !allowedWorkerDiagnosticTypes.has(event.type as AnalyzeDiagnosticEventType) ||
    typeof event.timestampMs !== "number" ||
    !Number.isFinite(event.timestampMs) ||
    event.terminal !== false
  ) {
    return undefined;
  }
  return makeDiagnosticEvent(
    runId,
    event.timestampMs,
    event.type as AnalyzeDiagnosticEventType,
    event.attributes !== null && typeof event.attributes === "object"
      ? (event.attributes as Record<string, unknown>)
      : {},
  );
}

export function parseAnalyzeWorkerEvent(
  line: string,
): Effect.Effect<AnalyzeWorkerEvent, AnalyzeProtocolError> {
  return Effect.gen(function* () {
    const value = yield* parseObjectLine(line);
    const runId = yield* validateEnvelope(value);
    switch (value.type) {
      case AnalyzeWorkerMessageType.Started:
        return { version: 1, type: AnalyzeWorkerMessageType.Started, runId };
      case AnalyzeWorkerMessageType.Diagnostic: {
        const event = parseWorkerDiagnostic(value.event, runId);
        if (!event) {
          return yield* protocolFailure(
            AnalyzeProtocolErrorKind.Malformed,
            "Analyze worker diagnostic event is invalid",
          );
        }
        return { version: 1, type: AnalyzeWorkerMessageType.Diagnostic, runId, event };
      }
      case AnalyzeWorkerMessageType.Result: {
        const result = yield* parseAnalysisResult(value.result);
        return { version: 1, type: AnalyzeWorkerMessageType.Result, runId, result };
      }
      case AnalyzeWorkerMessageType.Complete:
        return { version: 1, type: AnalyzeWorkerMessageType.Complete, runId };
      case AnalyzeWorkerMessageType.Request:
        return yield* protocolFailure(
          AnalyzeProtocolErrorKind.State,
          "Worker output cannot contain a request",
        );
      default:
        return yield* protocolFailure(
          AnalyzeProtocolErrorKind.Malformed,
          "Analyze worker message type is invalid",
        );
    }
  });
}

export const AnalyzeProtocolPhase = {
  Initial: "initial",
  Started: "started",
  Result: "result",
  Complete: "complete",
} as const;
export type AnalyzeProtocolPhase = (typeof AnalyzeProtocolPhase)[keyof typeof AnalyzeProtocolPhase];

export interface AnalyzeProtocolBudget {
  readonly bytes: number;
  readonly runId: string;
  readonly phase: AnalyzeProtocolPhase;
  readonly event?: AnalyzeWorkerEvent;
}

export function initialProtocolBudget(runId: string): AnalyzeProtocolBudget {
  return { bytes: 0, runId, phase: AnalyzeProtocolPhase.Initial };
}

export function acceptProtocolLine(
  budget: AnalyzeProtocolBudget,
  line: string,
): Effect.Effect<AnalyzeProtocolBudget, AnalyzeProtocolError> {
  if (budget.phase === AnalyzeProtocolPhase.Complete) {
    return protocolFailure(
      AnalyzeProtocolErrorKind.State,
      "Analyze worker emitted data after terminal completion",
    );
  }
  const bytes = budget.bytes + Buffer.byteLength(line, "utf8") + 1;
  if (bytes > MAX_PROTOCOL_TOTAL_BYTES) {
    return protocolFailure(
      AnalyzeProtocolErrorKind.TotalLimit,
      "Analyze worker protocol exceeded its total byte limit",
    );
  }
  return parseAnalyzeWorkerEvent(line).pipe(
    Effect.flatMap((event) => {
      if (event.runId !== budget.runId) {
        return protocolFailure(AnalyzeProtocolErrorKind.State, "Analyze worker changed runId");
      }
      let phase: AnalyzeProtocolPhase;
      switch (budget.phase) {
        case AnalyzeProtocolPhase.Initial:
          if (event.type !== AnalyzeWorkerMessageType.Started) {
            return protocolFailure(
              AnalyzeProtocolErrorKind.State,
              "Analyze worker must start before emitting events",
            );
          }
          phase = AnalyzeProtocolPhase.Started;
          break;
        case AnalyzeProtocolPhase.Started:
          if (event.type === AnalyzeWorkerMessageType.Diagnostic) {
            phase = AnalyzeProtocolPhase.Started;
          } else if (event.type === AnalyzeWorkerMessageType.Result) {
            phase = AnalyzeProtocolPhase.Result;
          } else {
            return protocolFailure(
              AnalyzeProtocolErrorKind.State,
              "Analyze worker emitted an out-of-order event",
            );
          }
          break;
        case AnalyzeProtocolPhase.Result:
          if (event.type !== AnalyzeWorkerMessageType.Complete) {
            return protocolFailure(
              AnalyzeProtocolErrorKind.State,
              "Analyze worker must complete immediately after result",
            );
          }
          phase = AnalyzeProtocolPhase.Complete;
          break;
        case AnalyzeProtocolPhase.Complete:
          return protocolFailure(
            AnalyzeProtocolErrorKind.State,
            "Analyze worker emitted data after terminal completion",
          );
      }
      return Effect.succeed({ bytes, runId: budget.runId, phase, event });
    }),
  );
}
