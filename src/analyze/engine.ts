import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Effect } from "effect";
import { asyncRisks, complexity, duplicates, similarTypes } from "./analyzers.js";
import { runBenchmark, type BenchmarkConfig } from "./benchmark.js";
import { bundleAnalyzer, dependencyAnalyzer, eslintAnalyzer, knipAnalyzer } from "./external.js";
import {
  AnalyzerName,
  ConfigError,
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
const DEFAULT_MEMORY_MB = 3072;
const defaultChecks = Object.values(AnalyzerName).filter((name) => name !== AnalyzerName.Bundle);

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
  if (!Number.isInteger(budget) || budget <= 0) {
    throw new ConfigError({ message: "maxMemoryMb must be a positive integer" });
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

async function dispatchAnalyzer(
  name: AnalyzerName,
  options: AnalyzeOptions,
  scope: Scope,
  project: Project | undefined,
  guard: () => boolean,
): Promise<Finding[]> {
  switch (name) {
    case AnalyzerName.Complexity:
      return complexity(project!, options.cwd, scope);
    case AnalyzerName.Duplicates:
      return duplicates(project!, options.cwd, scope);
    case AnalyzerName.Types:
      return similarTypes(project!, options.cwd, scope, options.typeSimilarityThreshold);
    case AnalyzerName.AsyncRisk:
      return asyncRisks(project!, options.cwd, scope);
    case AnalyzerName.Eslint:
      return eslintAnalyzer(options.cwd, scope);
    case AnalyzerName.Dependencies:
      return dependencyAnalyzer(options.cwd, scope);
    case AnalyzerName.Knip:
      return knipAnalyzer(options.cwd);
    case AnalyzerName.Bundle:
      return bundleAnalyzer(options.cwd, scope, { beforeEntry: guard });
  }
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

export function analyze(
  options: AnalyzeOptions,
  seams: EngineSeams = {},
): Effect.Effect<AnalysisResult, never> {
  return Effect.promise(async () => {
    const started = performance.now();
    const recorder = createProfileRecorder(options.profile === true);
    const findings: Finding[] = [];
    const failures: AnalyzerFailure[] = [];
    const benchmarks: BenchmarkResult[] = [];
    let stopped = false;

    try {
      const budget = validateOptions(options);
      const checks = selectedChecks(options);
      const scope = recorder.measure("scope", () =>
        resolveScope(options.cwd, options.scope, options.paths ?? [], options.ref));
      recorder.snapshot("after:scope");

      const guard = (name: AnalyzerName): boolean => {
        const value = recorder.snapshot(`before:${name}`);
        if (!isMemoryBudgetExceeded(value.rssBytes, budget)) return true;
        if (!stopped) {
          failures.push({
            analyzer: name,
            message: `Memory budget exceeded: RSS ${value.rssBytes} bytes > ${budget} MiB guard; remaining expensive stages skipped`,
          });
        }
        stopped = true;
        return false;
      };

      let project: Project | undefined;
      if (needsInternalProgram(checks)) {
        const firstInternal = checks.find((name) => INTERNAL.has(name))!;
        if (guard(firstInternal)) {
          project = recorder.measure("program", () =>
            (seams.createProject ?? createProject)(options.cwd));
          recorder.snapshot("after:program");
        }
      }

      const ordered = [
        ...checks.filter((name) => INTERNAL.has(name)),
        ...checks.filter((name) => !INTERNAL.has(name)),
      ];
      // Analyzer stages intentionally remain sequential so the internal Program
      // can be released before external tools claim their own large heaps.
      for (const name of ordered) {
        if (!INTERNAL.has(name)) project = undefined;
        if (stopped || !guard(name)) break;
        const analyzerStarted = performance.now();
        try {
          findings.push(...await dispatchAnalyzer(name, options, scope, project, () => guard(name)));
        } catch (cause) {
          failures.push({
            analyzer: name,
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
        if (options.profile) recorder.timings[name] = performance.now() - analyzerStarted;
        recorder.snapshot(`after:${name}`);
        if (isMemoryBudgetExceeded(process.memoryUsage().rss, budget)) {
          failures.push({
            analyzer: name,
            message: "Memory budget exceeded after analyzer; remaining expensive stages skipped",
          });
          stopped = true;
        }
      }

      // Benchmark runs are also intentionally sequential for stable measurements
      // and bounded peak memory. Sequential-await findings are review signals,
      // not mandates to parallelize memory-sensitive work.
      if (!stopped) {
        for (const config of options.benchmarks ?? []) {
          const value = await runBenchmark(config);
          benchmarks.push(value);
          if (value.failure) failures.push({ analyzer: "benchmark", message: value.failure });
        }
      }
      if (options.profile) recorder.timings.totalMs = performance.now() - started;
      recorder.snapshot("complete");
      return finalizeResult(findings, failures, benchmarks, options, recorder);
    } catch (cause) {
      const tag = (cause as { _tag?: string })._tag;
      const failure: AnalyzerFailure = {
        analyzer: tag === "ConfigError" ? "configuration" : tag === "ScopeError" ? "scope" : "program",
        message: cause instanceof Error ? cause.message : String(cause),
      };
      if (options.profile) recorder.timings.totalMs = performance.now() - started;
      recorder.snapshot("complete");
      return finalizeResult([], [failure], [], options, recorder);
    }
  });
}
