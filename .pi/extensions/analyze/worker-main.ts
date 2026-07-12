import { Effect, Result } from "effect";
import {
  AnalyzeWorkerMessageType,
  parseAnalyzeWorkerRequest,
} from "../../../src/analyze/protocol.js";
import {
  AnalyzeDiagnosticEventType,
  makeEffectAnalysisDiagnostics,
  type AnalysisDiagnosticEvent,
} from "../../../src/analyze/diagnostics.js";
import { ANALYZE_LIMITS } from "../../../src/analyze/policy.js";
import type { AnalysisResult, AnalyzerFailure, Finding } from "../../../src/analyze/model.js";

const MAX_INPUT_BYTES = 64 * 1024;

function safeFinding(finding: Finding): Finding {
  return {
    id: finding.id.slice(0, 128),
    analyzer: finding.analyzer,
    kind: finding.kind,
    severity: finding.severity,
    message: finding.message.slice(0, ANALYZE_LIMITS.messageLength),
    location: finding.location,
    ...(finding.related === undefined
      ? {}
      : { related: finding.related.slice(0, ANALYZE_LIMITS.relatedLocations) }),
  };
}

function safeFailure(failure: AnalyzerFailure): AnalyzerFailure {
  return { analyzer: failure.analyzer, message: failure.message.slice(0, 1_024) };
}

function boundedResult(result: AnalysisResult): AnalysisResult {
  const findings = result.findings.slice(0, ANALYZE_LIMITS.findings).map(safeFinding);
  const failures = result.analyzerFailures.slice(0, ANALYZE_LIMITS.failures - 1).map(safeFailure);
  let dropped =
    result.findings.length -
    findings.length +
    result.analyzerFailures.length -
    failures.length +
    result.benchmarks.length;

  const materialize = (): AnalysisResult => {
    const analyzerFailures: AnalyzerFailure[] = [
      ...failures,
      ...(dropped > 0
        ? [
            {
              analyzer: "supervisor" as const,
              message: `Worker result truncated ${dropped} record(s) to the protocol bound`,
            },
          ]
        : []),
    ];
    return {
      version: 1,
      summary: {
        info: findings.filter((finding) => finding.severity === "info").length,
        warning: findings.filter((finding) => finding.severity === "warning").length,
        error: findings.filter((finding) => finding.severity === "error").length,
        failures: analyzerFailures.length,
      },
      findings,
      analyzerFailures,
      benchmarks: [],
    };
  };

  let bounded = materialize();
  while (
    Buffer.byteLength(JSON.stringify(bounded), "utf8") > ANALYZE_LIMITS.resultBytes &&
    (findings.length > 0 || failures.length > 0)
  ) {
    if (findings.length > 0) findings.pop();
    else failures.pop();
    dropped += 1;
    bounded = materialize();
  }
  return bounded;
}

async function main(): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) {
      process.stderr.write("invalid request\n");
      process.exitCode = 2;
      return;
    }
  }
  const line = input.endsWith("\n") ? input.slice(0, -1) : input;
  const parsed = await Effect.runPromise(Effect.result(parseAnalyzeWorkerRequest(line)));
  if (Result.isFailure(parsed)) {
    process.stderr.write("invalid request\n");
    process.exitCode = 2;
    return;
  }

  const request = parsed.success;
  const emit = (value: unknown): void => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  };
  emit({
    version: 1,
    type: AnalyzeWorkerMessageType.Started,
    runId: request.runId,
  });

  try {
    // This literal dynamic import is bundled into the isolated worker sidecar.
    // Public parent bundles never import the engine, program builder, or TypeScript.
    const { analyze } = await import("../../../src/analyze/engine.js");
    const diagnostics = makeEffectAnalysisDiagnostics({
      telemetryEnabled: false,
      sink: (event: AnalysisDiagnosticEvent) => {
        if (event.terminal || event.type === AnalyzeDiagnosticEventType.RunStarted) {
          return Effect.void;
        }
        return Effect.sync(() => {
          emit({
            version: 1,
            type: AnalyzeWorkerMessageType.Diagnostic,
            runId: request.runId,
            event,
          });
        });
      },
    });
    const result = await Effect.runPromise(
      analyze(
        {
          cwd: request.cwd,
          scope: request.scope,
          paths: request.paths,
          ref: request.ref,
          checks: request.checks,
          maxMemoryMb: request.maxMemoryMb,
        },
        { diagnostics, runId: request.runId },
      ),
    );
    emit({
      version: 1,
      type: AnalyzeWorkerMessageType.Result,
      runId: request.runId,
      result: boundedResult(result),
    });
    emit({
      version: 1,
      type: AnalyzeWorkerMessageType.Complete,
      runId: request.runId,
    });
  } catch {
    process.stderr.write("worker failed\n");
    process.exitCode = 1;
  }
}

void main();
