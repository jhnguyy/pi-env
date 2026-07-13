import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node";
import { describe, expect, it } from "vitest";
import { AnalyzerName, ScopeMode } from "../model.js";
import { ANALYZE_LIMITS, classifyAnalyzeRequest, type SafeAnalyzeRequest } from "../policy.js";
import { runPublicAnalyze } from "../public.js";
import { readJournalEvents } from "../journal.js";
import { analyzeWorkerPath, superviseAnalyze } from "../supervisor.js";
import { AnalyzeDiagnosticEventType, AnalyzeSpanName } from "../diagnostics.js";

const fixtureRoot = (): string => mkdtempSync(join(tmpdir(), "pi-analyze-supervisor-"));
const disabledEnv = { PI_ENV_ANALYZE_JOURNAL_ENABLED: "false" } as const;

function safeRequest(cwd: string, overrides: Partial<SafeAnalyzeRequest> = {}): SafeAnalyzeRequest {
  return {
    cwd,
    scope: ScopeMode.Paths,
    paths: ["src/example.ts"],
    checks: [AnalyzerName.Complexity],
    maxMemoryMb: ANALYZE_LIMITS.maxMemoryMb,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function writeWorker(directory: string, body: string): string {
  const path = join(directory, `worker-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    path,
    `let input = "";
for await (const chunk of process.stdin) input += String(chunk);
const request = JSON.parse(input);
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
${body}
`,
    { mode: 0o700 },
  );
  return path;
}

const emptyResult = `{
  version: 1,
  summary: { info: 0, warning: 0, error: 0, failures: 0 },
  findings: [],
  analyzerFailures: [],
  benchmarks: []
}`;

function validWorker(directory: string, diagnostic = ""): string {
  return writeWorker(
    directory,
    `emit({ version: 1, type: "started", runId: request.runId });
${diagnostic}
emit({ version: 1, type: "result", runId: request.runId, result: ${emptyResult} });
emit({ version: 1, type: "complete", runId: request.runId });`,
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function processTreeFixture(
  mode: "abort" | "timeout",
): Promise<{ workerPid: number; grandchildPid: number }> {
  const cwd = fixtureRoot();
  const pidFile = join(cwd, "pids.json");
  const worker = writeWorker(
    cwd,
    `const { spawn } = await import("node:child_process");
const { writeFileSync } = await import("node:fs");
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ workerPid: process.pid, grandchildPid: grandchild.pid }));
emit({ version: 1, type: "started", runId: request.runId });
setInterval(() => {}, 1000);`,
  );
  const controller = new AbortController();
  const promise = superviseAnalyze(
    safeRequest(cwd, { timeoutMs: mode === "timeout" ? 1_000 : 5_000 }),
    { workerPath: worker, signal: controller.signal, env: disabledEnv },
  );
  await waitFor(() => existsSync(pidFile));
  const pids = JSON.parse(readFileSync(pidFile, "utf8")) as {
    workerPid: number;
    grandchildPid: number;
  };
  if (mode === "abort") controller.abort();
  await expect(promise).rejects.toThrow(mode === "abort" ? "cancelled" : "timed out");
  await waitFor(() => !isAlive(pids.workerPid) && !isAlive(pids.grandchildPid));
  return pids;
}

describe("safe analyze policy", () => {
  it("allows only explicit safe checks on diff or bounded relative paths", () => {
    const cwd = fixtureRoot();
    expect(
      classifyAnalyzeRequest({
        cwd,
        scope: ScopeMode.Diff,
        checks: [AnalyzerName.Complexity, AnalyzerName.AsyncRisk],
        maxMemoryMb: 8_192,
      }),
    ).toMatchObject({
      _tag: "safe",
      request: { maxMemoryMb: 512, checks: ["complexity", "async-risk"] },
    });
    expect(
      classifyAnalyzeRequest({
        cwd,
        scope: ScopeMode.Paths,
        paths: ["src/a.ts"],
        checks: [AnalyzerName.AsyncRisk],
      }),
    ).toMatchObject({ _tag: "safe" });
    for (const path of ["../outside.ts", "src/../../outside.ts", "src\\..\\outside.ts"]) {
      expect(
        classifyAnalyzeRequest({
          cwd,
          scope: ScopeMode.Paths,
          paths: [path],
          checks: [AnalyzerName.AsyncRisk],
        }),
      ).toMatchObject({ _tag: "invalid" });
    }
  });

  it("fails closed for omitted/invalid checks and classifies heavy work as strict", () => {
    const cwd = fixtureRoot();
    expect(classifyAnalyzeRequest({ cwd })).toMatchObject({ _tag: "invalid" });
    expect(
      classifyAnalyzeRequest({ cwd, checks: [AnalyzerName.Complexity, AnalyzerName.Complexity] }),
    ).toMatchObject({ _tag: "invalid" });
    expect(
      classifyAnalyzeRequest({ cwd, scope: ScopeMode.All, checks: [AnalyzerName.Complexity] }),
    ).toMatchObject({ _tag: "strict" });
    expect(classifyAnalyzeRequest({ cwd, checks: [AnalyzerName.Types] })).toMatchObject({
      _tag: "strict",
    });
    expect(
      classifyAnalyzeRequest({ cwd, checks: [AnalyzerName.Complexity], profile: true }),
    ).toMatchObject({ _tag: "strict" });
    expect(
      classifyAnalyzeRequest({
        cwd,
        checks: [AnalyzerName.Complexity],
        ref: "--upload-pack=malicious",
      }),
    ).toMatchObject({ _tag: "invalid" });
  });
});

describe("analyze supervisor", () => {
  it("reports worker spawn failures through the supervisor boundary", async () => {
    await expect(
      superviseAnalyze(safeRequest(fixtureRoot()), {
        env: { ...disabledEnv, PI_ENV_NODE_BIN: "/definitely/missing/pi-env-node" },
      }),
    ).rejects.toMatchObject({ kind: "process" });
  });

  it("accepts valid bounded worker protocol and ignores NODE_EXECUTABLE", async () => {
    const cwd = fixtureRoot();
    expect(process.env.PI_ENV_NODE_BIN).toBeTruthy();
    await expect(
      superviseAnalyze(safeRequest(cwd), {
        workerPath: validWorker(cwd),
        env: {
          ...disabledEnv,
          PI_ENV_NODE_BIN: process.env.PI_ENV_NODE_BIN,
          NODE_EXECUTABLE: "/not/a/reusable/node",
        },
      }),
    ).resolves.toMatchObject({ summary: { failures: 0 }, findings: [] });
  });

  it.each([
    [
      "result before started",
      `emit({ version: 1, type: "result", runId: request.runId, result: ${emptyResult} });`,
    ],
    ["wrong run id", `emit({ version: 1, type: "started", runId: "wrong" });`],
    [
      "duplicate started",
      `emit({ version: 1, type: "started", runId: request.runId }); emit({ version: 1, type: "started", runId: request.runId });`,
    ],
    [
      "complete before result",
      `emit({ version: 1, type: "started", runId: request.runId }); emit({ version: 1, type: "complete", runId: request.runId });`,
    ],
    [
      "post terminal",
      `emit({ version: 1, type: "started", runId: request.runId }); emit({ version: 1, type: "result", runId: request.runId, result: ${emptyResult} }); emit({ version: 1, type: "complete", runId: request.runId }); emit({ version: 1, type: "complete", runId: request.runId });`,
    ],
  ])("rejects %s protocol", async (_name, body) => {
    const cwd = fixtureRoot();
    await expect(
      superviseAnalyze(safeRequest(cwd), {
        workerPath: writeWorker(cwd, body),
        env: disabledEnv,
      }),
    ).rejects.toThrow("invalid protocol");
  });

  it.runIf(process.platform !== "win32")("cleans descendants after a valid worker exits successfully", async () => {
    const cwd = fixtureRoot();
    const pidFile = join(cwd, "successful-descendant.pid");
    const worker = writeWorker(
      cwd,
      `const { spawn } = await import("node:child_process");
const { writeFileSync } = await import("node:fs");
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
descendant.unref();
writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid));
emit({ version: 1, type: "started", runId: request.runId });
emit({ version: 1, type: "result", runId: request.runId, result: ${emptyResult} });
emit({ version: 1, type: "complete", runId: request.runId });`,
    );
    await expect(
      superviseAnalyze(safeRequest(cwd), { workerPath: worker, env: disabledEnv }),
    ).resolves.toMatchObject({ summary: { failures: 0 } });
    const descendantPid = Number(readFileSync(pidFile, "utf8"));
    await waitFor(() => !isAlive(descendantPid));
  });

  it("kills a worker that exceeds cumulative output bounds", async () => {
    const cwd = fixtureRoot();
    const worker = writeWorker(
      cwd,
      `process.stdout.write("x".repeat(${ANALYZE_LIMITS.stdoutBytes + 1})); setInterval(() => {}, 1000);`,
    );
    await expect(
      superviseAnalyze(safeRequest(cwd), { workerPath: worker, env: disabledEnv }),
    ).rejects.toThrow("stdout exceeded");
  });

  it("kills the complete process group on AbortSignal cancellation", async () => {
    const pids = await processTreeFixture("abort");
    expect(isAlive(pids.workerPid)).toBe(false);
    expect(isAlive(pids.grandchildPid)).toBe(false);
  });

  it("kills the complete process group on timeout", async () => {
    const pids = await processTreeFixture("timeout");
    expect(isAlive(pids.workerPid)).toBe(false);
    expect(isAlive(pids.grandchildPid)).toBe(false);
  });

  it("owns one bounded OTel root and exactly one sanitized terminal journal event", async () => {
    const cwd = fixtureRoot();
    const journalDirectory = join(cwd, "journal");
    const spans: ReadableSpan[] = [];
    const exporter: SpanExporter = {
      export: (items, callback) => {
        spans.push(...items);
        callback({ code: 0 });
      },
      forceFlush: async () => {},
      shutdown: async () => {},
    };
    const diagnostic = `emit({
      version: 1,
      type: "diagnostic",
      runId: request.runId,
      event: {
        version: 1,
        runId: request.runId,
        timestampMs: Date.now(),
        type: "stage-started",
        attributes: { stage: "scope", path: "/secret/file.ts", token: "secret" },
        terminal: false
      }
    });`;
    await superviseAnalyze(safeRequest(cwd), {
      workerPath: validWorker(cwd, diagnostic),
      journalDirectory,
      otelExporter: exporter,
      env: {
        PI_ENV_ANALYZE_OTEL_ENABLED: "true",
        PI_ENV_ANALYZE_OTEL_ENDPOINT: "http://collector.invalid:4318",
      },
    });

    expect(spans.filter((span) => span.name === AnalyzeSpanName.Run)).toHaveLength(1);
    const events = await readJournalEvents(journalDirectory);
    expect(events.filter((event) => event.terminal)).toHaveLength(1);
    expect(events.at(-1)?.type).toBe(AnalyzeDiagnosticEventType.RunCompleted);
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  it("runs the real isolated worker for a safe explicit path", async () => {
    const cwd = process.cwd();
    expect(existsSync(analyzeWorkerPath())).toBe(true);
    const result = await superviseAnalyze(
      safeRequest(cwd, { paths: ["src/analyze/policy.ts"], timeoutMs: 20_000 }),
      { env: disabledEnv },
    );
    expect(result.analyzerFailures).toEqual([]);
  }, 30_000);
});

describe("public analyze boundary", () => {
  it("returns safe worker results and refuses heavy/all work before spawn", async () => {
    const cwd = fixtureRoot();
    const marker = join(cwd, "spawned");
    const worker = writeWorker(
      cwd,
      `const { writeFileSync } = await import("node:fs");
writeFileSync(${JSON.stringify(marker)}, "spawned");
emit({ version: 1, type: "started", runId: request.runId });
emit({ version: 1, type: "result", runId: request.runId, result: ${emptyResult} });
emit({ version: 1, type: "complete", runId: request.runId });`,
    );
    const safe = await runPublicAnalyze(
      { cwd, scope: ScopeMode.Paths, paths: ["src/a.ts"], checks: [AnalyzerName.Complexity] },
      { workerPath: validWorker(cwd), env: disabledEnv },
    );
    expect(safe.summary.failures).toBe(0);

    const strict = await runPublicAnalyze(
      { cwd, scope: ScopeMode.All, checks: [AnalyzerName.Complexity] },
      { workerPath: worker, env: disabledEnv },
    );
    expect(strict.analyzerFailures[0]).toMatchObject({ analyzer: "containment" });
    expect(existsSync(marker)).toBe(false);
  });

  it("reports invalid explicit OTLP configuration before spawning", async () => {
    const cwd = fixtureRoot();
    const marker = join(cwd, "otel-spawned");
    const worker = writeWorker(
      cwd,
      `const { writeFileSync } = await import("node:fs"); writeFileSync(${JSON.stringify(marker)}, "spawned");`,
    );
    const result = await runPublicAnalyze(
      {
        cwd,
        scope: ScopeMode.Paths,
        paths: ["src/a.ts"],
        checks: [AnalyzerName.Complexity],
      },
      {
        workerPath: worker,
        env: {
          PI_ENV_ANALYZE_JOURNAL_ENABLED: "false",
          PI_ENV_ANALYZE_OTEL_ENABLED: "true",
        },
      },
    );
    expect(result.analyzerFailures[0]?.message).toContain("must be an http(s) URL");
    expect(existsSync(marker)).toBe(false);
  });

  it("keeps parent runtime modules isolated from the analyzer engine", () => {
    const root = process.cwd();
    for (const path of [
      "src/analyze/public.ts",
      "src/analyze/supervisor.ts",
      "src/analyze/policy.ts",
      ".pi/extensions/analyze/index.ts",
      "scripts/analyze.ts",
    ]) {
      const source = readFileSync(join(root, path), "utf8");
      expect(source, path).not.toMatch(/from ["']\.\/?(?:engine|program)/);
      expect(source, path).not.toMatch(/from ["']typescript["']/);
    }
  });
});
