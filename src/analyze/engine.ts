import { createHash } from "node:crypto";
import { Context, Effect } from "effect";
import { runBenchmarkEffect, type BenchmarkConfig } from "./benchmark.js";
import {
  AnalyzerName,
  ConfigError,
  ProgramError,
  ScopeError,
  type AnalyzeError,
  type AnalysisProfile,
  type AnalysisResult,
  type AnalyzerFailure,
  type BenchmarkResult,
  type Finding,
  type MemorySnapshot,
  type ScopeMode,
} from "./model.js";
import { createAnalysisProjectEffect, ProjectRequirement, type Project } from "./program.js";
import { ProcessService, processServiceLayer, type streamProcessEffect } from "./process.js";
import { analyzerDescriptor, defaultAnalyzerNames, projectRequirement, runAnalyzer } from "./registry.js";
import { resolveScopeEffect, type Scope } from "./scope.js";

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

/** The only runtime dependency of the analysis workflow: suitable for deterministic tests. */
export interface AnalysisRuntime {
  now(): number;
  memory(): MemorySnapshot;
}

export const AnalysisRuntime = Context.GenericTag<AnalysisRuntime>("pi-env/AnalysisRuntime");

const liveAnalysisRuntime: AnalysisRuntime = {
  now: () => performance.now(),
  memory: () => {
    const memory = process.memoryUsage();
    return { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external };
  },
};

type ProjectFactoryResult = Project | undefined | Effect.Effect<Project | undefined, ProgramError>;

export interface EngineSeams {
  /** Supports both the current Effect seam and the original synchronous factory. */
  createAnalysisProject?: (cwd: string, scope: Scope, requirement: ProjectRequirement) => ProjectFactoryResult;
  /** @deprecated The full-project seam is retained for existing integrations. */
  createProject?: (cwd: string) => Project | Effect.Effect<Project, ProgramError>;
  processRunner?: typeof streamProcessEffect;
  /** Additive seam; existing project and process seams remain supported. */
  runtime?: AnalysisRuntime;
}

interface AnalysisState {
  findings: readonly Finding[];
  failures: readonly AnalyzerFailure[];
  benchmarks: readonly BenchmarkResult[];
  profile: AnalysisProfile;
  stopped: boolean;
}

interface AnalysisPlan {
  budget: number;
  checks: readonly AnalyzerName[];
  scope: Scope;
  started: number;
  state: AnalysisState;
}

const DEFAULT_MEMORY_MB = 2048;
export const MAX_TOTAL_FINDINGS = 2_000 as const;

export function capFindings(findings: readonly Finding[], max: number): { kept: Finding[]; truncated: boolean; truncatedCount: number } {
  const kept = findings.slice(0, max);
  return { kept, truncated: findings.length > max, truncatedCount: Math.max(0, findings.length - kept.length) };
}

const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);

export const findingId = (finding: Finding): string => createHash("sha256").update(stable({
  analyzer: finding.analyzer, kind: finding.kind, message: finding.message, location: finding.location, related: finding.related ?? [],
})).digest("hex").slice(0, 20);

export const isMemoryBudgetExceeded = (rssBytes: number, maxMemoryMb: number): boolean => rssBytes > maxMemoryMb * 1024 * 1024;
export const needsInternalProject = (checks: readonly AnalyzerName[]): boolean => projectRequirement(checks) !== ProjectRequirement.None;

function validateOptionsEffect(options: AnalyzeOptions): Effect.Effect<number, ConfigError> {
  const threshold = options.typeSimilarityThreshold;
  if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)) {
    return Effect.fail(new ConfigError({ message: "Type similarity threshold must be between 0 and 1" }));
  }
  const budget = options.maxMemoryMb ?? DEFAULT_MEMORY_MB;
  if (!Number.isInteger(budget) || budget <= 0) return Effect.fail(new ConfigError({ message: "maxMemoryMb must be a positive integer" }));
  if (options.externalTimeoutMs !== undefined && (!Number.isInteger(options.externalTimeoutMs) || options.externalTimeoutMs < 1)) {
    return Effect.fail(new ConfigError({ message: "externalTimeoutMs must be an integer >= 1" }));
  }
  return Effect.succeed(budget);
}

function selectedChecksEffect(options: AnalyzeOptions): Effect.Effect<readonly AnalyzerName[], ConfigError> {
  const requested = options.checks ?? defaultAnalyzerNames;
  const valid = new Set<string>(Object.values(AnalyzerName));
  const unknown = requested.filter((name) => !valid.has(name));
  if (unknown.length > 0) return Effect.fail(new ConfigError({
    message: `Unknown checks: ${unknown.join(", ")}. Valid checks: ${Object.values(AnalyzerName).join(", ")}`,
  }));
  const selected = [...requested] as AnalyzerName[];
  if (options.bundle && !selected.includes(AnalyzerName.Bundle)) selected.push(AnalyzerName.Bundle);
  return Effect.succeed(selected);
}

const emptyProfile = (): AnalysisProfile => ({ timings: {}, memory: {}, peak: { rssBytes: 0, heapUsedBytes: 0, externalBytes: 0 } });
const initialState = (): AnalysisState => ({ findings: [], failures: [], benchmarks: [], profile: emptyProfile(), stopped: false });
const failure = (analyzer: AnalyzerFailure["analyzer"], message: string): AnalyzerFailure => ({ analyzer, message });
const toProgramError = (cause: unknown): ProgramError => cause instanceof ProgramError
  ? cause
  : new ProgramError({ message: cause instanceof Error ? cause.message : String(cause) });

function snapshot(state: AnalysisState, enabled: boolean, name: string, value: MemorySnapshot): AnalysisState {
  if (!enabled) return state;
  return {
    ...state,
    profile: {
      ...state.profile,
      memory: { ...state.profile.memory, [name]: value },
      peak: {
        rssBytes: Math.max(state.profile.peak.rssBytes, value.rssBytes),
        heapUsedBytes: Math.max(state.profile.peak.heapUsedBytes, value.heapUsedBytes),
        externalBytes: Math.max(state.profile.peak.externalBytes, value.externalBytes),
      },
    },
  };
}

function timing(state: AnalysisState, enabled: boolean, name: string, started: number, ended: number): AnalysisState {
  return enabled ? { ...state, profile: { ...state.profile, timings: { ...state.profile.timings, [name]: ended - started } } } : state;
}

function addFailure(state: AnalysisState, analyzer: AnalyzerFailure["analyzer"], message: string): AnalysisState {
  return { ...state, failures: [...state.failures, failure(analyzer, message)] };
}

function addFindings(state: AnalysisState, analyzer: AnalyzerName, findings: readonly Finding[]): AnalysisState {
  const capped = capFindings(findings, Math.max(0, MAX_TOTAL_FINDINGS - state.findings.length));
  const next = { ...state, findings: [...state.findings, ...capped.kept] };
  return capped.truncated
    ? addFailure(next, analyzer, `Global finding limit reached; dropped ${capped.truncatedCount} additional finding(s) after keeping ${MAX_TOTAL_FINDINGS} total deterministically`)
    : next;
}

function memoryGuard(state: AnalysisState, enabled: boolean, budget: number, name: AnalyzerName, value: MemorySnapshot): AnalysisState {
  const sampled = snapshot(state, enabled, `before:${name}`, value);
  if (!isMemoryBudgetExceeded(value.rssBytes, budget) || sampled.stopped) return sampled;
  return { ...addFailure(sampled, name, `Memory budget exceeded: RSS ${value.rssBytes} bytes > ${budget} MiB guard; remaining expensive stages skipped`), stopped: true };
}

function finalizeResult(state: AnalysisState, options: AnalyzeOptions): AnalysisResult {
  const findings = state.findings.map((item) => ({ ...item, id: findingId(item) })).sort((left, right) => left.location.path.localeCompare(right.location.path)
    || left.location.line - right.location.line || left.id.localeCompare(right.id));
  return {
    version: 1,
    summary: {
      info: findings.filter((item) => item.severity === "info").length,
      warning: findings.filter((item) => item.severity === "warning").length,
      error: findings.filter((item) => item.severity === "error").length,
      failures: state.failures.length,
    },
    findings,
    analyzerFailures: state.failures,
    benchmarks: state.benchmarks,
    ...(options.profile ? { profile: state.profile } : {}),
  };
}

function setupAnalysis(options: AnalyzeOptions): Effect.Effect<AnalysisPlan, AnalyzeError, ProcessService | AnalysisRuntime> {
  return Effect.gen(function* () {
    const runtime = yield* AnalysisRuntime;
    const started = runtime.now();
    const budget = yield* validateOptionsEffect(options);
    const selected = yield* selectedChecksEffect(options);
    // This preflight is deliberately before scope/project capability loading and analyzer dispatch.
    // A rejected check must not raise the shared project's capability for checks that can run.
    let state = initialState();
    const checks = selected.filter((name) => {
      const minimum = analyzerDescriptor(name).minimumTotalMemoryMb;
      if (budget >= minimum) return true;
      state = addFailure(state, name, `Insufficient memory budget: maxMemoryMb ${budget} MiB is below this analyzer's ${minimum} MiB minimum`);
      return false;
    });
    const scopeStarted = runtime.now();
    const scope = yield* resolveScopeEffect(options.cwd, options.scope, options.paths ?? [], options.ref);
    state = timing(state, options.profile === true, "scope", scopeStarted, runtime.now());
    state = snapshot(state, options.profile === true, "after:scope", runtime.memory());
    return { budget, checks, scope, started, state };
  });
}

function loadProjectIfNeeded(options: AnalyzeOptions, seams: EngineSeams, plan: AnalysisPlan): Effect.Effect<{ project?: Project; state: AnalysisState }, ProgramError, AnalysisRuntime> {
  const requirement = projectRequirement(plan.checks);
  if (requirement === ProjectRequirement.None) return Effect.succeed({ state: plan.state });
  const first = plan.checks.find((name) => analyzerDescriptor(name).project !== ProjectRequirement.None)!;
  return Effect.gen(function* () {
    const runtime = yield* AnalysisRuntime;
    let state = memoryGuard(plan.state, options.profile === true, plan.budget, first, runtime.memory());
    if (state.stopped) return { state };
    const started = runtime.now();
    const created = yield* Effect.try({
      try: () => seams.createAnalysisProject !== undefined
        ? seams.createAnalysisProject(options.cwd, plan.scope, requirement)
        : seams.createProject !== undefined
          ? seams.createProject(options.cwd)
          : createAnalysisProjectEffect(options.cwd, plan.scope, requirement),
      catch: toProgramError,
    });
    const project = yield* (Effect.isEffect(created) ? created : Effect.succeed(created));
    state = timing(state, options.profile === true, "program", started, runtime.now());
    state = snapshot(state, options.profile === true, "after:program", runtime.memory());
    return { project, state };
  });
}

/** A synchronous bundle hook is required by the bundle implementation; it records its single transition for the workflow to apply. */
function bundleGate(runtime: AnalysisRuntime, budget: number): { beforeEntry: () => boolean; samples: readonly MemorySnapshot[]; exceeded?: MemorySnapshot } {
  const samples: MemorySnapshot[] = [];
  let exceeded: MemorySnapshot | undefined;
  return {
    beforeEntry: () => {
      const value = runtime.memory();
      samples.push(value);
      if (isMemoryBudgetExceeded(value.rssBytes, budget)) {
        exceeded ??= value;
        return false;
      }
      return true;
    },
    get samples() { return samples; },
    get exceeded() { return exceeded; },
  };
}

function runStage(options: AnalyzeOptions, checks: readonly AnalyzerName[], scope: Scope, project: Project | undefined, budget: number, initial: AnalysisState): Effect.Effect<AnalysisState, never, ProcessService | AnalysisRuntime> {
  return Effect.gen(function* () {
    const runtime = yield* AnalysisRuntime;
    let state = initial;
    for (const name of checks) {
      if (state.stopped) break;
      state = memoryGuard(state, options.profile === true, budget, name, runtime.memory());
      if (state.stopped) break;
      const started = runtime.now();
      const gate = name === AnalyzerName.Bundle ? bundleGate(runtime, budget) : undefined;
      const outcome = yield* Effect.either(runAnalyzer(name, {
        cwd: options.cwd, scope, project, typeSimilarityThreshold: options.typeSimilarityThreshold, maxMemoryMb: budget,
        externalTimeoutMs: options.externalTimeoutMs, beforeBundleEntry: gate?.beforeEntry ?? (() => true),
      }));
      for (const sample of gate?.samples ?? []) state = snapshot(state, options.profile === true, `before:${name}`, sample);
      if (gate?.exceeded !== undefined) state = { ...addFailure(state, name, `Memory budget exceeded: RSS ${gate.exceeded.rssBytes} bytes > ${budget} MiB guard; remaining expensive stages skipped`), stopped: true };
      state = outcome._tag === "Right" ? addFindings(state, name, outcome.right) : addFailure(state, outcome.left.analyzer, outcome.left.message);
      state = timing(state, options.profile === true, name, started, runtime.now());
      state = snapshot(state, options.profile === true, `after:${name}`, runtime.memory());
      const after = runtime.memory();
      if (isMemoryBudgetExceeded(after.rssBytes, budget)) {
        state = { ...addFailure(state, name, "Memory budget exceeded after analyzer; remaining expensive stages skipped"), stopped: true };
      }
    }
    return state;
  });
}

function runInternalStages(options: AnalyzeOptions, seams: EngineSeams, plan: AnalysisPlan, checks: readonly AnalyzerName[]): Effect.Effect<AnalysisState, ProgramError, ProcessService | AnalysisRuntime> {
  return Effect.gen(function* () {
    const loaded = yield* loadProjectIfNeeded(options, seams, { ...plan, checks });
    // Keep the Project inside this scope so it is releasable before external tools start.
    return yield* runStage(options, checks, plan.scope, loaded.project, plan.budget, loaded.state);
  });
}

function runBenchmarks(options: AnalyzeOptions, initial: AnalysisState): Effect.Effect<AnalysisState, never, ProcessService> {
  return Effect.gen(function* () {
    let state = initial;
    for (const config of options.benchmarks ?? []) {
      const outcome = yield* Effect.either(runBenchmarkEffect(config));
      if (outcome._tag === "Right") state = { ...state, benchmarks: [...state.benchmarks, outcome.right] };
      else state = addFailure({ ...state, benchmarks: [...state.benchmarks, { command: [config.command, ...config.args].join(" "), runs: outcome.left.runs ?? [], failure: outcome.left.message }] }, "benchmark", outcome.left.message);
    }
    return state;
  });
}

export function analyzeEffect(options: AnalyzeOptions, seams: EngineSeams = {}): Effect.Effect<AnalysisResult, AnalyzeError> {
  const workflow = Effect.gen(function* () {
    const plan = yield* setupAnalysis(options);
    const internal = plan.checks.filter((name) => analyzerDescriptor(name).project !== ProjectRequirement.None);
    const external = plan.checks.filter((name) => analyzerDescriptor(name).project === ProjectRequirement.None);
    const afterInternal = yield* runInternalStages(options, seams, plan, internal);
    const afterExternal = yield* runStage(options, external, plan.scope, undefined, plan.budget, afterInternal);
    const afterBenchmarks = afterExternal.stopped ? afterExternal : yield* runBenchmarks(options, afterExternal);
    const runtime = yield* AnalysisRuntime;
    let state = timing(afterBenchmarks, options.profile === true, "totalMs", plan.started, runtime.now());
    state = snapshot(state, options.profile === true, "complete", runtime.memory());
    return finalizeResult(state, options);
  });
  return workflow.pipe(Effect.provideService(AnalysisRuntime, seams.runtime ?? liveAnalysisRuntime), Effect.provide(processServiceLayer(seams.processRunner)));
}

export function analyze(options: AnalyzeOptions, seams: EngineSeams = {}): Effect.Effect<AnalysisResult, never> {
  const failed = (analyzer: AnalyzerFailure["analyzer"], message: string): AnalysisResult => finalizeResult(addFailure(initialState(), analyzer, message), options);
  return analyzeEffect(options, seams).pipe(Effect.catchTags({
    ConfigError: (error) => Effect.succeed(failed("configuration", error.message)),
    ScopeError: (error) => Effect.succeed(failed("scope", error.message)),
    ProgramError: (error) => Effect.succeed(failed("program", error.message)),
  }));
}
