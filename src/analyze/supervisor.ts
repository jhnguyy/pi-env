import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SpanExporter } from "@opentelemetry/sdk-trace-node";
import { Effect } from "effect";
import {
  AnalyzeWorkerMessageType,
  AnalyzeProtocolPhase,
  acceptProtocolLine,
  initialProtocolBudget,
  type AnalyzeProtocolBudget,
  type AnalyzeWorkerEvent,
} from "./protocol.js";
import { ANALYZE_LIMITS, type SafeAnalyzeRequest } from "./policy.js";
import type { AnalysisResult } from "./model.js";
import {
  AnalyzeDiagnosticEventType,
  AnalyzeOutcome,
  AnalyzeSpanName,
  AnalyzeTerminationReason,
  analysisRunAttributes,
  makeDiagnosticEvent,
  makeEffectAnalysisDiagnostics,
} from "./diagnostics.js";
import { AnalysisJournal, journalSink } from "./journal.js";
import { makeAnalyzeOtelLayer, resolveAnalyzeOtelConfig } from "./otel.js";

const MAX_REQUEST_BYTES = 64 * 1024;

export class AnalyzeSupervisorError extends Error {
  constructor(
    readonly kind: "timeout" | "cancelled" | "protocol" | "process" | "configuration",
    message: string,
  ) {
    super(message);
    this.name = "AnalyzeSupervisorError";
  }
}

export interface SupervisorOptions {
  readonly workerPath?: string;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: AnalyzeWorkerEvent) => void;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly journalDirectory?: string;
  readonly journal?: AnalysisJournal;
  readonly otelExporter?: SpanExporter;
}

export function analyzeWorkerPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return (
    env.PI_ENV_ANALYZE_WORKER ??
    new URL("../../.pi/extensions/analyze/dist/worker.js", import.meta.url).pathname
  );
}

function journalEnabled(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return true;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function defaultJournalDirectory(env: Readonly<Record<string, string | undefined>>): string {
  const stateHome = env.XDG_STATE_HOME?.trim();
  return join(
    stateHome && stateHome.length > 0 ? stateHome : join(homedir(), ".local", "state"),
    "pi-env",
    "analyze",
  );
}

function processExists(pid: number, detached: boolean): boolean {
  try {
    process.kill(detached && process.platform !== "win32" ? -pid : pid, 0);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}

function signalProcess(pid: number, detached: boolean, signal: NodeJS.Signals): void {
  try {
    process.kill(detached && process.platform !== "win32" ? -pid : pid, signal);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
  }
}

async function terminateProcessGroup(child: ChildProcess, detached: boolean): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return;
  signalProcess(pid, detached, "SIGTERM");
  const deadline = Date.now() + ANALYZE_LIMITS.terminationGraceMs;
  while (Date.now() < deadline && processExists(pid, detached)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (processExists(pid, detached)) signalProcess(pid, detached, "SIGKILL");
}

function terminationReason(error: AnalyzeSupervisorError): AnalyzeTerminationReason {
  switch (error.kind) {
    case "timeout":
      return AnalyzeTerminationReason.Timeout;
    case "cancelled":
      return AnalyzeTerminationReason.Cancelled;
    case "protocol":
      return AnalyzeTerminationReason.Protocol;
    case "configuration":
      return AnalyzeTerminationReason.Configuration;
    case "process":
      return AnalyzeTerminationReason.Unknown;
  }
}

async function waitForClose(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("close", () => resolve());
  });
}

export async function superviseAnalyze(
  request: SafeAnalyzeRequest,
  options: SupervisorOptions = {},
): Promise<AnalysisResult> {
  const env: Readonly<Record<string, string | undefined>> = {
    ...process.env,
    ...options.env,
  };
  const configured = await Effect.runPromise(Effect.either(resolveAnalyzeOtelConfig(env)));
  if (configured._tag === "Left") {
    throw new AnalyzeSupervisorError("configuration", configured.left.message);
  }

  const configuredJournalDirectory = env.PI_ENV_ANALYZE_JOURNAL_DIR?.trim();
  const ownedJournal =
    options.journal === undefined && journalEnabled(env.PI_ENV_ANALYZE_JOURNAL_ENABLED)
      ? await AnalysisJournal.open({
          directory:
            options.journalDirectory ??
            (configuredJournalDirectory && configuredJournalDirectory.length > 0
              ? configuredJournalDirectory
              : defaultJournalDirectory(env)),
        })
      : undefined;
  const journal = options.journal ?? ownedJournal;
  const diagnostics = makeEffectAnalysisDiagnostics({
    telemetryEnabled: configured.right.enabled,
    sink: journal === undefined ? undefined : journalSink(journal),
  });
  const runId = randomUUID();
  const runStarted = Date.now();
  let terminalRecorded = false;

  const record = (
    type: AnalyzeDiagnosticEventType,
    attributes: Readonly<Record<string, unknown>> = {},
  ): Promise<void> =>
    Effect.runPromise(diagnostics.record(makeDiagnosticEvent(runId, Date.now(), type, attributes)));

  const finish = async (
    type:
      | typeof AnalyzeDiagnosticEventType.RunCompleted
      | typeof AnalyzeDiagnosticEventType.RunTerminated,
    outcome: AnalyzeOutcome,
    reason: AnalyzeTerminationReason,
    attributes: Readonly<Record<string, unknown>> = {},
  ): Promise<void> => {
    if (terminalRecorded) return;
    terminalRecorded = true;
    await record(type, {
      outcome,
      termination_reason: reason,
      duration_ms: Date.now() - runStarted,
      ...attributes,
    });
  };

  const lifecycle = async (): Promise<AnalysisResult> => {
    await record(AnalyzeDiagnosticEventType.RunStarted, analysisRunAttributes(request));
    if (options.signal?.aborted) {
      const error = new AnalyzeSupervisorError("cancelled", "analyze request was cancelled");
      await finish(
        AnalyzeDiagnosticEventType.RunTerminated,
        AnalyzeOutcome.Interrupted,
        AnalyzeTerminationReason.Cancelled,
      );
      throw error;
    }

    const node = env.PI_ENV_NODE_BIN ?? process.execPath;
    const detached = process.platform !== "win32";
    let child: ChildProcess;
    try {
      child = spawn(
        node,
        [
          `--max-old-space-size=${ANALYZE_LIMITS.maxMemoryMb}`,
          options.workerPath ?? analyzeWorkerPath(env),
        ],
        {
          cwd: request.cwd,
          detached,
          env: { ...process.env, ...env },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch {
      const error = new AnalyzeSupervisorError("process", "failed to spawn analyze worker");
      await finish(
        AnalyzeDiagnosticEventType.RunTerminated,
        AnalyzeOutcome.Failure,
        AnalyzeTerminationReason.Unknown,
      );
      throw error;
    }

    let pendingStdout = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let budget: AnalyzeProtocolBudget = initialProtocolBudget(runId);
    let result: AnalysisResult | undefined;
    let failure: AnalyzeSupervisorError | undefined;
    let stopping: Promise<void> | undefined;
    let protocolQueue: Promise<void> = Promise.resolve();

    const stop = (kind: AnalyzeSupervisorError["kind"], message: string): Promise<void> => {
      if (stopping !== undefined) return stopping;
      failure = new AnalyzeSupervisorError(kind, message);
      child.stdin?.destroy();
      stopping = terminateProcessGroup(child, detached).catch(() => undefined);
      return stopping;
    };

    const timeout = setTimeout(
      () => void stop("timeout", "analyze worker timed out"),
      request.timeoutMs,
    );
    const abort = (): void => {
      void stop("cancelled", "analyze request was cancelled");
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    child.once("error", () => {
      void stop("process", "analyze worker failed to spawn");
    });
    child.stdin?.on("error", () => {
      // Termination can close stdin while the bounded request is being written.
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > ANALYZE_LIMITS.stdoutBytes) {
        void stop("protocol", "analyze worker stdout exceeded its byte limit");
        return;
      }
      pendingStdout += chunk.toString("utf8");
      while (true) {
        const newline = pendingStdout.indexOf("\n");
        if (newline < 0) break;
        const line = pendingStdout.slice(0, newline);
        pendingStdout = pendingStdout.slice(newline + 1);
        protocolQueue = protocolQueue
          .then(async () => {
            budget = await Effect.runPromise(acceptProtocolLine(budget, line));
            const event = budget.event;
            if (event === undefined) return;
            if (event.type === AnalyzeWorkerMessageType.Diagnostic) {
              await record(event.event.type, event.event.attributes);
            }
            options.onEvent?.(event);
            if (event.type === AnalyzeWorkerMessageType.Result) result = event.result;
          })
          .catch(async () => {
            await stop("protocol", "analyze worker emitted invalid protocol");
          });
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > ANALYZE_LIMITS.stderrBytes) {
        void stop("protocol", "analyze worker stderr exceeded its byte limit");
      }
    });

    const requestLine = `${JSON.stringify({
      version: 1,
      type: AnalyzeWorkerMessageType.Request,
      runId,
      ...request,
    })}\n`;
    if (Buffer.byteLength(requestLine, "utf8") > MAX_REQUEST_BYTES) {
      await stop("configuration", "analyze worker request exceeded its byte limit");
    } else {
      child.stdin?.end(requestLine);
    }

    await waitForClose(child);
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    await protocolQueue;
    if (stopping !== undefined) await stopping;

    if (failure !== undefined) {
      await finish(
        AnalyzeDiagnosticEventType.RunTerminated,
        failure.kind === "cancelled" ? AnalyzeOutcome.Interrupted : AnalyzeOutcome.Failure,
        terminationReason(failure),
      );
      throw failure;
    }
    if (
      budget.phase !== AnalyzeProtocolPhase.Complete ||
      result === undefined ||
      pendingStdout.length > 0
    ) {
      const error = new AnalyzeSupervisorError(
        "process",
        "analyze worker exited without a complete bounded result",
      );
      await finish(
        AnalyzeDiagnosticEventType.RunTerminated,
        AnalyzeOutcome.Failure,
        AnalyzeTerminationReason.Unknown,
      );
      throw error;
    }

    await finish(
      AnalyzeDiagnosticEventType.RunCompleted,
      result.summary.failures === 0 ? AnalyzeOutcome.Success : AnalyzeOutcome.Failure,
      AnalyzeTerminationReason.Completed,
      {
        finding_count: result.findings.length,
        failure_count: result.summary.failures,
      },
    );
    return result;
  };

  try {
    return await Effect.runPromise(
      diagnostics
        .span(AnalyzeSpanName.Run, analysisRunAttributes(request), Effect.promise(lifecycle))
        .pipe(Effect.provide(makeAnalyzeOtelLayer(configured.right, options.otelExporter))),
    );
  } finally {
    if (ownedJournal !== undefined) await ownedJournal.close();
  }
}
