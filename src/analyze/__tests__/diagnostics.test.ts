import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  AnalyzeDiagnosticEventType,
  AnalyzeOutcome,
  AnalyzeSpanName,
  AnalyzeTerminationReason,
  MAX_DIAGNOSTIC_STRING_LENGTH,
  makeDiagnosticEvent,
  makeEffectAnalysisDiagnostics,
  sanitizeDiagnosticAttributes,
} from "../diagnostics.js";
import { analyzeEffect } from "../engine.js";
import { AnalysisJournal, readJournalEvents } from "../journal.js";
import { ScopeMode } from "../model.js";
import { ANALYZE_OTEL_BOUNDS, makeAnalyzeOtelLayer, resolveAnalyzeOtelConfig } from "../otel.js";
import {
  ANALYZE_WORKER_PROTOCOL_VERSION,
  AnalyzeProtocolErrorKind,
  AnalyzeWorkerMessageType,
  MAX_PROTOCOL_LINE_BYTES,
  acceptProtocolLine,
  initialProtocolBudget,
  parseAnalyzeWorkerEvent,
  parseAnalyzeWorkerRequest,
} from "../protocol.js";

const fixtureRoot = (): string => mkdtempSync(join(tmpdir(), "pi-analyze-diagnostics-"));

function event(
  runId: string,
  timestampMs: number,
  type: AnalyzeDiagnosticEventType,
  extra: Record<string, unknown> = {},
) {
  return makeDiagnosticEvent(runId, timestampMs, type, extra);
}

async function leftKind(
  effect: Effect.Effect<unknown, { readonly kind: string }>,
): Promise<string | undefined> {
  const result = await Effect.runPromise(Effect.either(effect));
  return result._tag === "Left" ? result.left.kind : undefined;
}

describe("analyze diagnostic contracts", () => {
  it("keeps telemetry attributes bounded and excludes sensitive or high-cardinality values", () => {
    const attributes = sanitizeDiagnosticAttributes({
      scope_mode: "diff",
      analyzer: "complexity",
      stage: "x".repeat(500),
      path: "/secret/worktree/file.ts",
      token: "bearer-secret",
      stdout: "source text",
      command: "rm -rf /",
      max_memory_mb: Number.POSITIVE_INFINITY,
    });
    expect(attributes).toEqual({
      scope_mode: "diff",
      analyzer: "complexity",
      stage: "x".repeat(MAX_DIAGNOSTIC_STRING_LENGTH),
    });
    expect(JSON.stringify(attributes)).not.toContain("secret");
  });

  it("exports Effect spans through a bounded optional OpenTelemetry layer", async () => {
    const finished: ReadableSpan[] = [];
    const exporter: SpanExporter = {
      export: (spans, callback) => {
        finished.push(...spans);
        callback({ code: 0 });
      },
      forceFlush: async () => {},
      shutdown: async () => {},
    };
    const diagnostics = makeEffectAnalysisDiagnostics({ telemetryEnabled: true });
    const runId = "run-otel";
    const program = diagnostics
      .span(
        AnalyzeSpanName.Run,
        { scope_mode: "diff", path: "/not-exported" },
        diagnostics.record(
          event(runId, 1, AnalyzeDiagnosticEventType.StageStarted, { stage: "preflight" }),
        ),
      )
      .pipe(Effect.provide(makeAnalyzeOtelLayer({ enabled: true }, exporter)));

    await Effect.runPromise(program);

    expect(finished).toEqual([
      expect.objectContaining({
        name: AnalyzeSpanName.Run,
        attributes: { scope_mode: "diff", stage: "preflight", run_id: runId },
      }),
    ]);
    expect(ANALYZE_OTEL_BOUNDS.maxQueueSize).toBeLessThanOrEqual(64);
    expect(ANALYZE_OTEL_BOUNDS.maxExportBatchSize).toBeLessThanOrEqual(
      ANALYZE_OTEL_BOUNDS.maxQueueSize,
    );
  });

  it("instruments the engine through an injected no-throw diagnostics seam", async () => {
    const events: ReturnType<typeof event>[] = [];
    const spans: string[] = [];
    let tick = 0;
    const result = await Effect.runPromise(
      analyzeEffect(
        {
          cwd: fixtureRoot(),
          scope: ScopeMode.All,
          checks: [],
        },
        {
          runId: "integrated-run",
          runtime: {
            now: () => ++tick,
            wallTime: () => 1_000 + tick,
            memory: () => ({ rssBytes: 10, heapUsedBytes: 5, externalBytes: 1 }),
          },
          diagnostics: {
            span: (name, _attributes, effect) => {
              spans.push(name);
              return effect;
            },
            record: (item) =>
              Effect.sync(() => {
                events.push(item);
              }),
          },
        },
      ),
    );

    expect(result.summary.failures).toBe(0);
    expect(spans).toEqual([
      AnalyzeSpanName.Preflight,
      AnalyzeSpanName.Scope,
      AnalyzeSpanName.Result,
    ]);
    expect(events.map((item) => item.type)).toEqual([
      AnalyzeDiagnosticEventType.RunStarted,
      AnalyzeDiagnosticEventType.StageStarted,
      AnalyzeDiagnosticEventType.StageCompleted,
      AnalyzeDiagnosticEventType.MemorySample,
      AnalyzeDiagnosticEventType.RunCompleted,
    ]);
    expect(events.at(-1)).toMatchObject({ runId: "integrated-run", terminal: true });
  });

  it("requires explicit valid configuration before enabling OTLP export", async () => {
    await expect(Effect.runPromise(resolveAnalyzeOtelConfig({}))).resolves.toEqual({
      enabled: false,
    });
    await expect(
      Effect.runPromise(
        resolveAnalyzeOtelConfig({
          PI_ENV_ANALYZE_OTEL_ENABLED: "true",
          PI_ENV_ANALYZE_OTEL_ENDPOINT: "http://collector:4318/",
        }),
      ),
    ).resolves.toEqual({ enabled: true, endpoint: "http://collector:4318" });
    await expect(
      Effect.runPromise(resolveAnalyzeOtelConfig({ PI_ENV_ANALYZE_OTEL_ENABLED: "sometimes" })),
    ).rejects.toThrow("must be a boolean");
    await expect(
      Effect.runPromise(resolveAnalyzeOtelConfig({ PI_ENV_ANALYZE_OTEL_ENABLED: "true" })),
    ).rejects.toThrow("must be an http(s) URL");
  });
});

describe("bounded crash journal", () => {
  it("rotates by file, aggregate bytes, count, and retains complete terminal evidence", async () => {
    const directory = fixtureRoot();
    const journal = await AnalysisJournal.open({
      directory,
      maxLineBytes: 512,
      maxFileBytes: 512,
      maxTotalBytes: 1_024,
      maxFiles: 3,
      maxAgeMs: 60_000,
      flushEveryEvents: 2,
    });
    for (let index = 0; index < 12; index++) {
      await journal.append(
        event("bounded-run", index, AnalyzeDiagnosticEventType.StageCompleted, {
          stage: `stage-${index}-${"x".repeat(100)}`,
          duration_ms: index,
        }),
      );
    }
    await journal.append(
      event("bounded-run", 20, AnalyzeDiagnosticEventType.RunCompleted, {
        outcome: AnalyzeOutcome.Success,
        termination_reason: AnalyzeTerminationReason.Completed,
      }),
    );
    await journal.close();

    const names = (await readdir(directory)).filter((name) => name.endsWith(".ndjson"));
    const sizes = await Promise.all(
      names.map(async (name) => (await stat(join(directory, name))).size),
    );
    expect(names.length).toBeLessThanOrEqual(3);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(1_024);
    expect(sizes.every((size) => size <= 512)).toBe(true);
    const recovered = await readJournalEvents(directory);
    expect(recovered.at(-1)).toMatchObject({
      runId: "bounded-run",
      type: AnalyzeDiagnosticEventType.RunCompleted,
      terminal: true,
    });
    expect(JSON.stringify(recovered)).not.toContain("/secret/");
  });

  it("recovers complete records before a partial crash line", async () => {
    const directory = fixtureRoot();
    const complete = event("crashed-run", 1, AnalyzeDiagnosticEventType.StageStarted, {
      stage: "project-load",
    });
    writeFileSync(
      join(directory, "current.ndjson"),
      `${JSON.stringify(complete)}\n{"version":1,"runId":"crashed`,
      { mode: 0o600 },
    );
    await expect(readJournalEvents(directory)).resolves.toEqual([complete]);
  });

  it("disables permanently and reports only once after a journal write boundary fails", async () => {
    const root = fixtureRoot();
    const notDirectory = join(root, "not-a-directory");
    writeFileSync(notDirectory, "x");
    const errors: Error[] = [];
    const journal = await AnalysisJournal.open({
      directory: notDirectory,
      onError: (error) => errors.push(error),
    });
    await journal.append(event("run", 1, AnalyzeDiagnosticEventType.RunStarted));
    await journal.append(event("run", 2, AnalyzeDiagnosticEventType.RunCompleted));
    await journal.close();
    expect(journal.disabled).toBe(true);
    expect(errors).toHaveLength(1);
  });

  it("never writes disallowed raw fields", async () => {
    const directory = fixtureRoot();
    const journal = await AnalysisJournal.open({ directory });
    await journal.append(
      event("safe-run", 1, AnalyzeDiagnosticEventType.Failure, {
        termination_reason: AnalyzeTerminationReason.Analyzer,
        path: "/secret/file.ts",
        stdout: "raw output",
      }),
    );
    await journal.close();
    const text = readFileSync(join(directory, "current.ndjson"), "utf8");
    expect(text).not.toContain("/secret/file.ts");
    expect(text).not.toContain("raw output");
  });
});

describe("analyze worker protocol", () => {
  const request = {
    version: ANALYZE_WORKER_PROTOCOL_VERSION,
    type: AnalyzeWorkerMessageType.Request,
    runId: "protocol-run",
    cwd: "/worktree",
    scope: "diff",
    checks: ["complexity"],
    maxMemoryMb: 512,
    timeoutMs: 10_000,
  } as const;

  it("accepts a bounded versioned request", async () => {
    await expect(
      Effect.runPromise(parseAnalyzeWorkerRequest(JSON.stringify(request))),
    ).resolves.toEqual(request);
  });

  it("rejects malformed, wrong-version, oversized, and invalid-direction messages", async () => {
    expect(await leftKind(parseAnalyzeWorkerRequest("{"))).toBe(AnalyzeProtocolErrorKind.Malformed);
    expect(
      await leftKind(parseAnalyzeWorkerRequest(JSON.stringify({ ...request, version: 2 }))),
    ).toBe(AnalyzeProtocolErrorKind.Version);
    expect(await leftKind(parseAnalyzeWorkerRequest("x".repeat(MAX_PROTOCOL_LINE_BYTES + 1)))).toBe(
      AnalyzeProtocolErrorKind.LineLimit,
    );
    expect(await leftKind(parseAnalyzeWorkerEvent(JSON.stringify(request)))).toBe(
      AnalyzeProtocolErrorKind.State,
    );
    for (const path of ["../outside.ts", "src/../../outside.ts", "src\\..\\outside.ts"]) {
      expect(
        await leftKind(
          parseAnalyzeWorkerRequest(JSON.stringify({ ...request, scope: "paths", paths: [path] })),
        ),
      ).toBe(AnalyzeProtocolErrorKind.Malformed);
    }
  });

  it("enforces started, result, complete, and terminal ordering", async () => {
    const workerEvent = (type: string, extra = {}) =>
      JSON.stringify({
        version: ANALYZE_WORKER_PROTOCOL_VERSION,
        type,
        runId: "protocol-run",
        ...extra,
      });
    let budget = await Effect.runPromise(
      acceptProtocolLine(initialProtocolBudget("protocol-run"), workerEvent("started")),
    );
    budget = await Effect.runPromise(
      acceptProtocolLine(
        budget,
        workerEvent("result", {
          result: {
            version: 1,
            summary: { info: 0, warning: 0, error: 0, failures: 0 },
            findings: [],
            analyzerFailures: [],
            benchmarks: [],
          },
        }),
      ),
    );
    const terminal = await Effect.runPromise(acceptProtocolLine(budget, workerEvent("complete")));
    expect(terminal.phase).toBe("complete");
    expect(await leftKind(acceptProtocolLine(terminal, workerEvent("complete")))).toBe(
      AnalyzeProtocolErrorKind.State,
    );
  });

  it("rejects inconsistent worker summaries", async () => {
    const raw = JSON.stringify({
      version: 1,
      type: "result",
      runId: "protocol-run",
      result: {
        version: 1,
        summary: { info: 1, warning: 0, error: 0, failures: 0 },
        findings: [],
        analyzerFailures: [],
        benchmarks: [],
      },
    });
    expect(await leftKind(parseAnalyzeWorkerEvent(raw))).toBe(AnalyzeProtocolErrorKind.Malformed);
  });

  it("rejects untrusted absolute and traversal result locations", async () => {
    for (const path of [
      "/secret/file.ts",
      "../outside.ts",
      "src/../../outside.ts",
      "src\\..\\outside.ts",
    ]) {
      const raw = JSON.stringify({
        version: 1,
        type: "result",
        runId: "protocol-run",
        result: {
          version: 1,
          summary: { info: 1, warning: 0, error: 0, failures: 0 },
          findings: [
            {
              id: "x",
              analyzer: "complexity",
              kind: "complexity",
              severity: "info",
              message: "x",
              location: { path, line: 1, column: 1 },
            },
          ],
          analyzerFailures: [],
          benchmarks: [],
        },
      });
      expect(await leftKind(parseAnalyzeWorkerEvent(raw))).toBe(AnalyzeProtocolErrorKind.Malformed);
    }
  });
});
