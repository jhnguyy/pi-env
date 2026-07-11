#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { validateBenchmark } from "../src/analyze/benchmark.js";
import { analyze } from "../src/analyze/engine.js";
import { formatResult, shouldFail } from "../src/analyze/format.js";
import { FailPolicy, OutputMode, ScopeMode, type AnalysisResult } from "../src/analyze/model.js";

const args = process.argv.slice(2);
const has = (flag: string): boolean => args.includes(flag);
const value = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};
const optionsWithValues = ["--ref", "--fail-on", "--checks", "--bench", "--type-threshold", "--max-memory-mb"];
const positional = args.filter((argument, index) =>
  !argument.startsWith("--") && (index === 0 || !optionsWithValues.includes(args[index - 1]!)));
const scope = has("--diff") ? ScopeMode.Diff : has("--all") ? ScopeMode.All : ScopeMode.Paths;
const mode = has("--json") ? OutputMode.Json : has("--pretty") ? OutputMode.Pretty : OutputMode.Compact;
const parseFailPolicy = (raw: string): FailPolicy => {
  const values = Object.values(FailPolicy);
  if (values.includes(raw as FailPolicy)) return raw as FailPolicy;
  throw new Error(`Unknown --fail-on value: ${raw}. Valid values: ${values.join(", ")}`);
};

let result: AnalysisResult;
let fail: FailPolicy = FailPolicy.Never;
try {
  fail = parseFailPolicy(value("--fail-on") ?? (has("--ci") ? FailPolicy.Warning : FailPolicy.Never));
  const benchmarkPath = value("--bench");
  const benchmarks = benchmarkPath
    ? [validateBenchmark(JSON.parse(readFileSync(benchmarkPath, "utf8")))]
    : [];
  result = await Effect.runPromise(analyze({
    cwd: process.cwd(),
    scope,
    paths: positional,
    ref: value("--ref"),
    checks: value("--checks")?.split(",").filter(Boolean),
    bundle: has("--bundle"),
    typeSimilarityThreshold: value("--type-threshold") === undefined ? undefined : Number(value("--type-threshold")),
    profile: has("--profile"),
    maxMemoryMb: value("--max-memory-mb") === undefined ? 3072 : Number(value("--max-memory-mb")),
    benchmarks,
  }));
} catch (cause) {
  result = {
    version: 1,
    summary: { info: 0, warning: 0, error: 0, failures: 1 },
    findings: [],
    analyzerFailures: [{ analyzer: "configuration", message: cause instanceof Error ? cause.message : String(cause) }],
    benchmarks: [],
  };
}
console.log(formatResult(result, mode));
process.exitCode = shouldFail(result, fail) ? 1 : 0;
