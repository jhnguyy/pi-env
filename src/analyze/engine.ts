import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Effect } from "effect";
import { asyncRisks, complexity, duplicates, similarTypes } from "./analyzers.js";
import { runBenchmarkEffect, type BenchmarkConfig } from "./benchmark.js";
import { bundleAnalyzer, dependencyAnalyzerEffect, eslintAnalyzerEffect, knipAnalyzerEffect } from "./external.js";
import {
  AnalyzerName,
  AnalyzerRunError,
  ConfigError,
  ProgramError,
  ScopeError,
  type AnalyzeError,
  type AnalysisResult,
  type AnalyzerFailure,
  type BenchmarkResult,
  type Finding,
  type MemorySnapshot,
  type ScopeMode,
} from "./model.js";
import { createProject, type Project } from "./program.js";
import { resolveScope, type Scope } from "./scope.js";

export interface AnalyzeOptions {
  cwd: string;
  scope: ScopeMode;
  paths?: readonly string[];
  ref?: string;
  checks?: readonly string[];
  bundle?: boolean;
  typeSimilarityThreshold?: number;
  profile?: boolean;
  benchmarks?: readonly BenchmarkConfig[];
  maxMemoryMb?: number;
  externalTimeoutMs?: number;
}

export interface EngineSeams {
  createProject?: typeof createProject;
}

interface ProfileRecorder {
  timings: Record<string, number>;
  memory: Record<string, MemorySnapshot>;
  peak: MemorySnapshot;
  snapshot: (name: string) => MemorySnapshot;
  measure: <Value>(name: string, operation: () => Value) => Value;
}

const INTERNAL = new Set<AnalyzerName>([
  AnalyzerName.Complexity,
  AnalyzerName.Duplicates,
  AnalyzerName.Types,
  AnalyzerName.AsyncRisk,
]);
const DEFAULT_MEMORY_MB = 2048;
export const MAX_TOTAL_FINDINGS = 2_000 as const;
const defaultChecks = Object.values(AnalyzerName).filter((name) => name !== AnalyzerName.Bundle);

export function capFindings(findings: readonly Finding[], max: number): {
  kept: Finding[];
  truncated: boolean;
  truncatedCount: number;
} {
  const kept = findings.slice(0, max);
  return {
    kept,
    truncated: findings.length > max,
    truncatedCount: Math.max(0, findings.length - kept.length),
  };
}

const stable = (value: unknown): string => JSON.stringify(
  value,
  (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
    : item,
);

export const findingId = (finding: Finding): string => createHash("sha256")
  .update(stable({
    analyzer: finding.analyzer,
    kind: finding.kind,
    message: finding.message,
    location: finding.location,
    related: finding.related ?? [],
  }))
  .digest("hex")
  .slice(0, 20);

export const isMemoryBudgetExceeded = (rssBytes: number, maxMemoryMb: number): boolean =>
  rssBytes > maxMemoryMb * 1024 * 1024;

export const needsInternalProgram = (checks: readonly AnalyzerName[]): boolean =>
  checks.some((check) => INTERNAL.has(check));

function validateOptions(options: AnalyzeOptions): number {
  const threshold = options.typeSimilarityThreshold;
  if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)) {
    throw new ConfigError({ message: "Type similarity threshold must be between 0 and 1" });
  }
  const budget = options.maxMemoryMb ?? DEFAULT_MEMORY_MB;
  if (!Number.isInteger(budget) || budget <= 0) throw new ConfigError({ message: "maxMemoryMb must be a positive integer" });
  if (options.externalTimeoutMs !== undefined && (!Number.isInteger(options.externalTimeoutMs) || options.externalTimeoutMs < 1)) {
    throw new ConfigError({ message: "externalTimeoutMs must be an integer >= 1" });
  }
  return budget;
}

function selectedChecks(options: AnalyzeOptions): AnalyzerName[] {
  const requested = options.checks ?? defaultChecks;
  const valid = new Set<string>(Object.values(AnalyzerName));
  const unknown = requested.filter((name) => !valid.has(name));
  if (unknown.length > 0) {
    throw new ConfigError({
      message: `Unknown checks: ${unknown.join(", ")}. Valid checks: ${Object.values(AnalyzerName).join(", ")}`,
    });
  }
  const selected = [...requested] as AnalyzerName[];
  if (options.bundle && !selected.includes(AnalyzerName.Bundle)) selected.push(AnalyzerName.Bundle);
  return selected;
}

function memorySnapshot(): MemorySnapshot {
  const memory = process.memoryUsage();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
  };
}

function createProfileRecorder(enabled: boolean): ProfileRecorder {
  const recorder: ProfileRecorder = {
    timings: {},
    memory: {},
    peak: { rssBytes: 0, heapUsedBytes: 0, externalBytes: 0 },
    snapshot(name) {
      const value = memorySnapshot();
      if (enabled) {
        recorder.memory[name] = value;
        recorder.peak = {
          rssBytes: Math.max(recorder.peak.rssBytes, value.rssBytes),
          heapUsedBytes: Math.max(recorder.peak.heapUsedBytes, value.heapUsedBytes),
          externalBytes: Math.max(recorder.peak.externalBytes, value.externalBytes),
        };
      }
      return value;
    },
    measure(name, operation) {
      const start = performance.now();
      try {
        return operation();
      } finally {
        if (enabled) recorder.timings[name] = performance.now() - start;
      }
    },
  };
  return recorder;
}

function dispatchAnalyzer(
  name: AnalyzerName,
  options: AnalyzeOptions,
  scope: Scope,
  project: Project | undefined,
  guard: () => boolean,
  budget: number,
): Effect.Effect<Finding[], AnalyzerRunError> {
  switch (name) {
    case AnalyzerName.Complexity: return Effect.sync(() => complexity(project!, options.cwd, scope));
    case AnalyzerName.Duplicates: return Effect.sync(() => duplicates(project!, options.cwd, scope));
    case AnalyzerName.Types: return Effect.sync(() => similarTypes(project!, options.cwd, scope, options.typeSimilarityThreshold));
    case AnalyzerName.AsyncRisk: return Effect.sync(() => asyncRisks(project!, options.cwd, scope));
    case AnalyzerName.Dependencies: return dependencyAnalyzerEffect(options.cwd, scope, budget, options.externalTimeoutMs);
    case AnalyzerName.Knip: return knipAnalyzerEffect(options.cwd, budget, options.externalTimeoutMs);
    case AnalyzerName.Eslint: return eslintAnalyzerEffect(options.cwd, scope, budget, options.externalTimeoutMs);
    case AnalyzerName.Bundle: return Effect.tryPromise({ try: () => bundleAnalyzer(options.cwd, scope, { beforeEntry: guard }), catch: (cause) => new AnalyzerRunError({ analyzer: name, message: cause instanceof Error ? cause.message : String(cause) }) });
  }
}

function toConfigError(cause: unknown): ConfigError {
  return cause instanceof ConfigError ? cause : new ConfigError({ message: String(cause) });
}

function toScopeError(cause: unknown): ScopeError {
  return cause instanceof ScopeError ? cause : new ScopeError({ message: cause instanceof Error ? cause.message : String(cause) });
}

function toProgramError(cause: unknown): ProgramError {
  return cause instanceof ProgramError ? cause : new ProgramError({ message: cause instanceof Error ? cause.message : String(cause) });
}

function toAnalyzerFailure(analyzer: AnalyzerFailure["analyzer"], message: string): AnalyzerFailure {
  return { analyzer, message };
}

function recordMemoryBudgetFailure(
  failures: AnalyzerFailure[],
  analyzer: AnalyzerFailure["analyzer"],
  message: string,
): void {
  failures.push(toAnalyzerFailure(analyzer, message));
}

function finalizeResult(
  findings: readonly Finding[],
  failures: readonly AnalyzerFailure[],
  benchmarks: AnalysisResult["benchmarks"],
  options: AnalyzeOptions,
  recorder: ProfileRecorder,
): AnalysisResult {
  const orderedFindings = findings
    .map((finding) => ({ ...finding, id: findingId(finding) }))
    .sort((left, right) => left.location.path.localeCompare(right.location.path)
      || left.location.line - right.location.line
      || left.id.localeCompare(right.id));
  return {
    version: 1,
    summary: {
      info: orderedFindings.filter((finding) => finding.severity === "info").length,
      warning: orderedFindings.filter((finding) => finding.severity === "warning").length,
      error: orderedFindings.filter((finding) => finding.severity === "error").length,
      failures: failures.length,
    },
    findings: orderedFindings,
    analyzerFailures: [...failures],
    benchmarks,
    ...(options.profile
      ? { profile: { timings: recorder.timings, memory: recorder.memory, peak: recorder.peak } }
      : {}),
  };
}

function setupAnalysis(options: AnalyzeOptions): Effect.Effect<{ budget: number; checks: AnalyzerName[]; scope: Scope; recorder: ProfileRecorder; started: number }, AnalyzeError> {
  const started = performance.now();
  const recorder = createProfileRecorder(options.profile === true);
  return Effect.gen(function* () {
    const budget = yield* Effect.try({ try: () => validateOptions(options), catch: toConfigError });
    const checks = yield* Effect.try({ try: () => selectedChecks(options), catch: toConfigError });
    const scope = yield* Effect.try({
      try: () => recorder.measure("scope", () => resolveScope(options.cwd, options.scope, options.paths ?? [], options.ref)),
      catch: toScopeError,
    });
    recorder.snapshot("after:scope");
    return { budget, checks, scope, recorder, started };
  });
}

function createMemoryGuard(recorder: ProfileRecorder, failures: AnalyzerFailure[], budget: number): { guard: (name: AnalyzerName) => boolean; stop: () => void; isStopped: () => boolean } {
  let stopped = false;
  return {
    guard(name) {
      const value = recorder.snapshot(`before:${name}`);
      if (!isMemoryBudgetExceeded(value.rssBytes, budget)) return true;
      if (!stopped) recordMemoryBudgetFailure(failures, name, `Memory budget exceeded: RSS ${value.rssBytes} bytes > ${budget} MiB guard; remaining expensive stages skipped`);
      stopped = true;
      return false;
    },
    stop: () => { stopped = true; },
    isStopped: () => stopped,
  };
}

function loadProjectIfNeeded(
  options: AnalyzeOptions,
  seams: EngineSeams,
  checks: readonly AnalyzerName[],
  recorder: ProfileRecorder,
  guard: (name: AnalyzerName) => boolean,
): Effect.Effect<Project | undefined, ProgramError> {
  if (!needsInternalProgram(checks)) return Effect.succeed(undefined);
  const firstInternal = checks.find((name) => INTERNAL.has(name))!;
  if (!guard(firstInternal)) return Effect.succeed(undefined);
  return Effect.try({
    try: () => recorder.measure("program", () => (seams.createProject ?? createProject)(options.cwd)),
    catch: toProgramError,
  }).pipe(Effect.tap(() => Effect.sync(() => { recorder.snapshot("after:program"); })));
}

function orderedChecks(checks: readonly AnalyzerName[]): AnalyzerName[] {
  return [...checks.filter((name) => INTERNAL.has(name)), ...checks.filter((name) => !INTERNAL.has(name))];
}

function runAnalyzers(
  options: AnalyzeOptions,
  checks: readonly AnalyzerName[],
  scope: Scope,
  project: Project | undefined,
  recorder: ProfileRecorder,
  failures: AnalyzerFailure[],
  findings: Finding[],
  budget: number,
  state: { guard: (name: AnalyzerName) => boolean; stop: () => void; isStopped: () => boolean },
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    let currentProject = project;
    for (const name of orderedChecks(checks)) {
      if (!INTERNAL.has(name)) currentProject = undefined;
      if (state.isStopped() || !state.guard(name)) break;
      const analyzerStarted = performance.now();
      const outcome = yield* Effect.either(dispatchAnalyzer(name, options, scope, currentProject, () => state.guard(name), budget));
      if (outcome._tag === "Right") {
        const capped = capFindings(outcome.right, Math.max(0, MAX_TOTAL_FINDINGS - findings.length));
        findings.push(...capped.kept);
        if (capped.truncated) failures.push(toAnalyzerFailure(name, `Global finding limit reached; dropped ${capped.truncatedCount} additional finding(s) after keeping ${MAX_TOTAL_FINDINGS} total deterministically`));
      } else failures.push(toAnalyzerFailure(outcome.left.analyzer, outcome.left.message));
      if (options.profile) recorder.timings[name] = performance.now() - analyzerStarted;
      recorder.snapshot(`after:${name}`);
      if (isMemoryBudgetExceeded(process.memoryUsage().rss, budget)) {
        recordMemoryBudgetFailure(failures, name, "Memory budget exceeded after analyzer; remaining expensive stages skipped");
        state.stop();
        break;
      }
    }
  });
}

function runBenchmarks(
  options: AnalyzeOptions,
  failures: AnalyzerFailure[],
  benchmarks: BenchmarkResult[],
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    for (const config of options.benchmarks ?? []) {
      const outcome = yield* Effect.either(runBenchmarkEffect(config));
      if (outcome._tag === "Right") benchmarks.push(outcome.right);
      else {
        benchmarks.push({ command: [config.command, ...config.args].join(" "), runs: outcome.left.runs ?? [], failure: outcome.left.message });
        failures.push(toAnalyzerFailure("benchmark", outcome.left.message));
      }
    }
  });
}

function finalizeAnalysis(
  options: AnalyzeOptions,
  recorder: ProfileRecorder,
  started: number,
  findings: readonly Finding[],
  failures: readonly AnalyzerFailure[],
  benchmarks: readonly BenchmarkResult[],
): AnalysisResult {
  if (options.profile) recorder.timings.totalMs = performance.now() - started;
  recorder.snapshot("complete");
  return finalizeResult(findings, failures, benchmarks, options, recorder);
}

export function analyzeEffect(
  options: AnalyzeOptions,
  seams: EngineSeams = {},
): Effect.Effect<AnalysisResult, AnalyzeError> {
  return Effect.gen(function* () {
    const { budget, checks, scope, recorder, started } = yield* setupAnalysis(options);
    const findings: Finding[] = [];
    const failures: AnalyzerFailure[] = [];
    const benchmarks: BenchmarkResult[] = [];
    const state = createMemoryGuard(recorder, failures, budget);
    const internalChecks = checks.filter((name) => INTERNAL.has(name));
    const externalChecks = checks.filter((name) => !INTERNAL.has(name));
    let project = yield* loadProjectIfNeeded(options, seams, internalChecks, recorder, state.guard);
    yield* runAnalyzers(options, internalChecks, scope, project, recorder, failures, findings, budget, state);
    project = undefined; // Release the sole Project reference before any external analyzer.
    if (!state.isStopped()) yield* runAnalyzers(options, externalChecks, scope, undefined, recorder, failures, findings, budget, state);
    if (!state.isStopped()) yield* runBenchmarks(options, failures, benchmarks);
    return finalizeAnalysis(options, recorder, started, findings, failures, benchmarks);
  });
}

export function analyze(options: AnalyzeOptions, seams: EngineSeams = {}): Effect.Effect<AnalysisResult, never> {
  const failureResult = (analyzer: AnalyzerFailure["analyzer"], message: string): AnalysisResult => {
    const recorder = createProfileRecorder(options.profile === true);
    return finalizeResult([], [toAnalyzerFailure(analyzer, message)], [], options, recorder);
  };
  return analyzeEffect(options, seams).pipe(Effect.catchTags({
    ConfigError: (error) => Effect.succeed(failureResult("configuration", error.message)),
    ScopeError: (error) => Effect.succeed(failureResult("scope", error.message)),
    ProgramError: (error) => Effect.succeed(failureResult("program", error.message)),
  }));
}
