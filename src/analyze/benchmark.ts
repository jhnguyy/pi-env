import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { BenchmarkError, type BenchmarkResult } from "./model.js";

const execute = promisify(execFile);

export interface BenchmarkConfig {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  warmups?: number;
  runs?: number;
}

function benchmarkRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new BenchmarkError({ message: "Benchmark must be an object" });
  }
  return value as Record<string, unknown>;
}

function validateCommand(value: Record<string, unknown>): void {
  const hasStringArgs = Array.isArray(value.args)
    && value.args.every((argument) => typeof argument === "string");
  if (typeof value.command !== "string" || !hasStringArgs) {
    throw new BenchmarkError({ message: "Benchmark requires command and string args" });
  }
}

function validateIntegerOption(
  value: Record<string, unknown>,
  key: "timeoutMs" | "warmups" | "runs",
  minimum: number,
): void {
  const option = value[key];
  if (option !== undefined && (!Number.isInteger(option) || (option as number) < minimum)) {
    throw new BenchmarkError({ message: `${key} must be an integer >= ${minimum}` });
  }
}

export function validateBenchmark(value: unknown): BenchmarkConfig {
  const record = benchmarkRecord(value);
  validateCommand(record);
  validateIntegerOption(record, "timeoutMs", 0);
  validateIntegerOption(record, "warmups", 0);
  validateIntegerOption(record, "runs", 1);
  return record as unknown as BenchmarkConfig;
}

async function executeBenchmark(config: BenchmarkConfig): Promise<void> {
  await execute(config.command, config.args, {
    cwd: config.cwd,
    timeout: config.timeoutMs ?? 30_000,
  });
}

export async function runBenchmark(config: BenchmarkConfig): Promise<BenchmarkResult> {
  const runs: number[] = [];
  try {
    // These loops are intentionally sequential: concurrent child processes would
    // distort measurements and violate the analyzer's bounded-memory policy.
    for (let index = 0; index < (config.warmups ?? 0); index++) {
      await executeBenchmark(config);
    }
    for (let index = 0; index < (config.runs ?? 1); index++) {
      const start = performance.now();
      await executeBenchmark(config);
      runs.push(performance.now() - start);
    }
    return {
      command: [config.command, ...config.args].join(" "),
      runs,
      meanMs: runs.reduce((sum, duration) => sum + duration, 0) / runs.length,
    };
  } catch (cause) {
    return {
      command: [config.command, ...config.args].join(" "),
      runs,
      failure: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
