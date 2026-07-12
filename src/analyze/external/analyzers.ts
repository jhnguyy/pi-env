import { relative, resolve } from "node:path";
import { Effect } from "effect";
import { AnalyzerName, AnalyzerRunError, ProcessErrorKind, type Finding, type ProcessError, type ProgramError } from "../model.js";
import { DEFAULT_EXTERNAL_TIMEOUT_MS, nodeAnalyzerEnvironment, ProcessService, type StreamProcessOptions } from "../process.js";
import { tsconfigFileNamesEffect } from "../program.js";
import type { Scope } from "../scope.js";
import { parseDependencyCruiserJson, parseOxlintJson, parseKnipOutput } from "./parsers.js";

const OUTPUT_LIMIT_BYTES = 20 * 1024 * 1024;
const MAX_ARGUMENT_BYTES = 128 * 1024;
const slash = (value: string): string => value.replaceAll("\\", "/");
const selectedTsPathsEffect = (cwd: string, scope: Scope): Effect.Effect<string[], ProgramError> =>
  tsconfigFileNamesEffect(cwd).pipe(
    Effect.map((files) => files
      .map((file) => slash(relative(cwd, file)))
      .filter((file) => !file.includes("node_modules/") && (scope.mode === "all" || scope.files.includes(file)))),
  );

const runProcess = (command: string, args: readonly string[], options: StreamProcessOptions) =>
  Effect.flatMap(ProcessService, ({ run }) => run(command, args, options));

const parseEffect = (
  analyzer: AnalyzerName,
  label: string,
  operation: () => Finding[],
): Effect.Effect<Finding[], AnalyzerRunError> => Effect.try({
  try: operation,
  catch: (cause) => new AnalyzerRunError({ analyzer, message: `Invalid ${label} output: ${cause instanceof Error ? cause.message : String(cause)}` }),
});

function nodeProcessOptions(cwd: string, maxMemoryMb: number, timeoutMs: number): StreamProcessOptions {
  return { cwd, timeoutMs, stdoutLimitBytes: OUTPUT_LIMIT_BYTES, stderrLimitBytes: OUTPUT_LIMIT_BYTES, env: nodeAnalyzerEnvironment(maxMemoryMb) };
}

/** Oxlint's launcher starts native workers; do not apply a synthetic Node heap cap. */
function nativeProcessOptions(cwd: string, timeoutMs: number): StreamProcessOptions {
  // tool-node-run.sh selects a directly executable host Node for launchers that
  // spawn process.execPath. Nub may run its downloaded Node through a dynamic
  // loader, which is not itself a valid Node executable for Oxlint's children.
  return {
    cwd,
    timeoutMs,
    stdoutLimitBytes: OUTPUT_LIMIT_BYTES,
    stderrLimitBytes: OUTPUT_LIMIT_BYTES,
    env: { ...process.env, PATH: `/bin:/usr/bin:${process.env.PATH ?? ""}` },
  };
}

function processFailureMessage(cause: ProcessError): string {
  const stderr = cause.stderr?.trim();
  if (!stderr) return cause.message;
  const excerpt = stderr.length > 2_000 ? `${stderr.slice(0, 2_000)}…` : stderr;
  return `${cause.message}\nstderr: ${excerpt}`;
}

function recoverExpectedFindingsExit(analyzer: AnalyzerName, cause: ProcessError): boolean {
  // Verified against local packages: oxlint/dist/cli.js sets exitCode=1 for
  // lint findings; dependency-cruiser/src/report/json.mjs returns exitCode=0
  // even when the JSON summary contains violations.
  return analyzer === AnalyzerName.Eslint && cause.kind === ProcessErrorKind.Exit && cause.exitCode === 1 && Boolean(cause.stdout);
}

function argumentBatches(values: readonly string[], fixed: readonly string[]): string[][] {
  const baseBytes = fixed.reduce((total, value) => total + Buffer.byteLength(value) + 1, 0);
  const batches: string[][] = [];
  let batch: string[] = [];
  let bytes = baseBytes;
  for (const value of values) {
    const valueBytes = Buffer.byteLength(value) + 1;
    if (valueBytes + baseBytes > MAX_ARGUMENT_BYTES) throw new Error(`Analyzer path exceeds ${MAX_ARGUMENT_BYTES} argument bytes: ${value}`);
    if (batch.length > 0 && bytes + valueBytes > MAX_ARGUMENT_BYTES) { batches.push(batch); batch = []; bytes = baseBytes; }
    batch.push(value);
    bytes += valueBytes;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

// The public analyzer/check name remains `eslint` for v1 compatibility; Oxlint is its implementation.
export function eslintAnalyzerEffect(cwd: string, scope: Scope, maxMemoryMb: number, timeoutMs: number = DEFAULT_EXTERNAL_TIMEOUT_MS): Effect.Effect<Finding[], AnalyzerRunError, ProcessService> {
  return Effect.gen(function* () {
    const command = resolve(cwd, "scripts/tool-node-run.sh");
    const launcher = resolve(cwd, "node_modules/oxlint/bin/oxlint");
    // Keep batches serial and Oxlint single-threaded: type-aware analysis can otherwise multiply
    // TypeScript program memory use. Do not add --type-check: this analyzer reports lint rules only.
    const fixed = ["--type-aware", "--format", "json", "--threads", "1", "--no-error-on-unmatched-pattern", "--"];
    const files = yield* selectedTsPathsEffect(cwd, scope).pipe(
      Effect.mapError((cause) => new AnalyzerRunError({ analyzer: AnalyzerName.Eslint, message: cause.message })),
    );
    const batches = yield* Effect.try({ try: () => argumentBatches(files, [launcher, ...fixed]), catch: (cause) => new AnalyzerRunError({ analyzer: AnalyzerName.Eslint, message: cause instanceof Error ? cause.message : String(cause) }) });
    const findings: Finding[] = [];
    // analyze: allow-sequential
    for (const batch of batches) {
      const parsed = yield* runProcess(command, [launcher, ...fixed, ...batch], nativeProcessOptions(cwd, timeoutMs)).pipe(
        Effect.flatMap(({ stdout }) => parseEffect(AnalyzerName.Eslint, "Oxlint", () => parseOxlintJson(stdout, cwd))),
        Effect.catchTag("ProcessError", (cause) => recoverExpectedFindingsExit(AnalyzerName.Eslint, cause)
          ? parseEffect(AnalyzerName.Eslint, "Oxlint", () => parseOxlintJson(cause.stdout!, cwd))
          : Effect.fail(new AnalyzerRunError({ analyzer: AnalyzerName.Eslint, message: processFailureMessage(cause) }))),
      );
      findings.push(...parsed);
      yield* Effect.yieldNow();
    }
    return findings;
  });
}

export function dependencyAnalyzerEffect(cwd: string, scope: Scope, maxMemoryMb: number, timeoutMs: number = DEFAULT_EXTERNAL_TIMEOUT_MS): Effect.Effect<Finding[], AnalyzerRunError, ProcessService> {
  const targets = scope.mode === "all" ? ["."] : scope.files.map((path) => path.startsWith("-") ? `./${path}` : path);
  if (targets.length === 0) return Effect.succeed([]);
  return Effect.gen(function* () {
    const script = resolve(cwd, "node_modules/dependency-cruiser/bin/dependency-cruise.mjs");
    const suffix = ["--output-type", "json", "--progress", "none"];
    const batches = yield* Effect.try({ try: () => argumentBatches(targets, [script, ...suffix]), catch: (cause) => new AnalyzerRunError({ analyzer: AnalyzerName.Dependencies, message: cause instanceof Error ? cause.message : String(cause) }) });
    const findings: Finding[] = [];
    // analyze: allow-sequential
    for (const batch of batches) {
      const parsed = yield* runProcess(resolve(cwd, "scripts/node-run.sh"), [script, ...batch, ...suffix], nodeProcessOptions(cwd, maxMemoryMb, timeoutMs)).pipe(
        Effect.flatMap(({ stdout }) => parseEffect(AnalyzerName.Dependencies, "dependency-cruiser", () => parseDependencyCruiserJson(stdout))),
        Effect.catchTag("ProcessError", (cause) => recoverExpectedFindingsExit(AnalyzerName.Dependencies, cause)
          ? parseEffect(AnalyzerName.Dependencies, "dependency-cruiser", () => parseDependencyCruiserJson(cause.stdout!))
          : Effect.fail(new AnalyzerRunError({ analyzer: AnalyzerName.Dependencies, message: processFailureMessage(cause) }))),
      );
      findings.push(...parsed);
      yield* Effect.yieldNow();
    }
    return findings;
  });
}

export function knipAnalyzerEffect(cwd: string, maxMemoryMb: number, timeoutMs: number = DEFAULT_EXTERNAL_TIMEOUT_MS): Effect.Effect<Finding[], AnalyzerRunError, ProcessService> {
  return runProcess(resolve(cwd, "scripts/node-run.sh"), [resolve(cwd, "node_modules/knip/bin/knip.js"), "--reporter", "compact", "--no-progress", "--no-exit-code"], nodeProcessOptions(cwd, maxMemoryMb, timeoutMs)).pipe(
    Effect.flatMap(({ stdout, stderr }) => parseEffect(AnalyzerName.Knip, "Knip", () => parseKnipOutput(`${stdout}\n${stderr}`))),
    Effect.mapError((cause) => cause instanceof AnalyzerRunError ? cause : new AnalyzerRunError({ analyzer: AnalyzerName.Knip, message: processFailureMessage(cause) })),
  );
}
