#!/usr/bin/env node
import { runPublicAnalyze } from "../src/analyze/public.js";
import { formatResult, shouldFail } from "../src/analyze/format.js";
import { FailPolicy, OutputMode, ScopeMode, type AnalysisResult } from "../src/analyze/model.js";

const args = process.argv.slice(2);
const valueFlags = new Set([
  "--bench",
  "--checks",
  "--fail-on",
  "--max-memory-mb",
  "--ref",
  "--type-similarity-threshold",
  "--type-threshold",
]);
const booleanFlags = new Set([
  "--all",
  "--bundle",
  "--ci",
  "--diff",
  "--json",
  "--pretty",
  "--profile",
]);
const values = new Map<string, string>();
const flags = new Set<string>();
const paths: string[] = [];
let parseError: string | undefined;

for (let index = 0; index < args.length; index++) {
  const argument = args[index]!;
  if (argument === "--") {
    continue;
  }
  if (valueFlags.has(argument)) {
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) {
      parseError = `${argument} requires a value`;
      break;
    }
    values.set(argument, value);
  } else if (booleanFlags.has(argument)) {
    flags.add(argument);
  } else if (argument.startsWith("--")) {
    parseError = `Unknown option: ${argument}`;
    break;
  } else {
    paths.push(argument);
  }
}

const failure = (message: string): AnalysisResult => ({
  version: 1,
  summary: { info: 0, warning: 0, error: 0, failures: 1 },
  findings: [],
  analyzerFailures: [{ analyzer: "configuration", message }],
  benchmarks: [],
});

const requestedFailPolicy =
  values.get("--fail-on") ?? (flags.has("--ci") ? FailPolicy.Warning : FailPolicy.Never);
const failPolicy = Object.values(FailPolicy).includes(requestedFailPolicy as FailPolicy)
  ? (requestedFailPolicy as FailPolicy)
  : undefined;
if (failPolicy === undefined) {
  parseError ??= `Unknown --fail-on value: ${requestedFailPolicy}. Valid values: ${Object.values(FailPolicy).join(", ")}`;
}

let result: AnalysisResult;
if (parseError !== undefined) {
  result = failure(parseError);
} else if (flags.has("--all") && (flags.has("--diff") || paths.length > 0)) {
  result = failure("--all cannot be combined with --diff or explicit paths");
} else {
  const threshold = values.get("--type-similarity-threshold") ?? values.get("--type-threshold");
  result = await runPublicAnalyze({
    cwd: process.cwd(),
    scope: flags.has("--all") ? ScopeMode.All : paths.length > 0 ? ScopeMode.Paths : ScopeMode.Diff,
    paths: paths.length > 0 ? paths : undefined,
    ref: values.get("--ref"),
    checks: values.get("--checks")?.split(",").filter(Boolean),
    maxMemoryMb:
      values.get("--max-memory-mb") === undefined
        ? undefined
        : Number(values.get("--max-memory-mb")),
    profile: flags.has("--profile"),
    bundle: flags.has("--bundle"),
    typeSimilarityThreshold: threshold === undefined ? undefined : Number(threshold),
    benchmarks: values.has("--bench") ? [values.get("--bench")] : undefined,
  });
}

const mode = flags.has("--json")
  ? OutputMode.Json
  : flags.has("--pretty")
    ? OutputMode.Pretty
    : OutputMode.Compact;
console.log(formatResult(result, mode));
process.exitCode =
  result.summary.failures > 0 || shouldFail(result, failPolicy ?? FailPolicy.Never) ? 1 : 0;
