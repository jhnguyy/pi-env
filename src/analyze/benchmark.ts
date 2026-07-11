import { performance } from "node:perf_hooks";
import { Effect } from "effect";
import { BenchmarkError, type BenchmarkResult } from "./model.js";
import { DEFAULT_BENCHMARK_TIMEOUT_MS, execFileEffect } from "./process.js";

export interface BenchmarkConfig {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  warmups?: number;
  runs?: number;
}

export const BENCHMARK_LIMITS = {
  timeoutMs: { min: 1, max: 300_000 },
  warmups: { min: 0, max: 10 },
  runs: { min: 1, max: 100 },
} as const;

function benchmarkRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new BenchmarkError({ message: "Benchmark must be an object" });
  return value as Record<string, unknown>;
}
function validateCommand(value: Record<string, unknown>): void {
  if (typeof value.command !== "string" || !Array.isArray(value.args) || !value.args.every((item) => typeof item === "string")) {
    throw new BenchmarkError({ message: "Benchmark requires command and string args" });
  }
}
function validateIntegerOption(
  value: Record<string, unknown>,
  key: "timeoutMs" | "warmups" | "runs",
  minimum: number,
  maximum: number,
): void {
  const option = value[key];
  if (option !== undefined && (!Number.isInteger(option) || (option as number) < minimum || (option as number) > maximum)) {
    throw new BenchmarkError({ message: `${key} must be an integer between ${minimum} and ${maximum}` });
  }
}
export function validateBenchmark(value: unknown): BenchmarkConfig {
  const record = benchmarkRecord(value);
  validateCommand(record);
  validateIntegerOption(record, "timeoutMs", BENCHMARK_LIMITS.timeoutMs.min, BENCHMARK_LIMITS.timeoutMs.max);
  validateIntegerOption(record, "warmups", BENCHMARK_LIMITS.warmups.min, BENCHMARK_LIMITS.warmups.max);
  validateIntegerOption(record, "runs", BENCHMARK_LIMITS.runs.min, BENCHMARK_LIMITS.runs.max);
  return record as unknown as BenchmarkConfig;
}

const commandLabel = (config: BenchmarkConfig): string => [config.command, ...config.args].join(" ");
const execute = (config: BenchmarkConfig) => execFileEffect(config.command, config.args, {
  cwd: config.cwd,
  timeoutMs: config.timeoutMs ?? DEFAULT_BENCHMARK_TIMEOUT_MS,
});

export function runBenchmarkEffect(config: BenchmarkConfig): Effect.Effect<BenchmarkResult, BenchmarkError> {
  const runs: number[] = [];
  return Effect.gen(function* () {
    // Sequential execution is required for stable measurements and bounded memory.
    for (let index = 0; index < (config.warmups ?? 0); index++) yield* execute(config);
    for (let index = 0; index < (config.runs ?? 1); index++) {
      const start = performance.now();
      yield* execute(config);
      runs.push(performance.now() - start);
    }
    return { command: commandLabel(config), runs, meanMs: runs.reduce((sum, value) => sum + value, 0) / runs.length };
  }).pipe(Effect.mapError((cause) => new BenchmarkError({ message: cause.message, runs: [...runs] })));
}
