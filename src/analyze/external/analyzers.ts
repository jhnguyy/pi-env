import { relative, resolve } from "node:path";
import { Effect } from "effect";
import { AnalyzerName, AnalyzerRunError, type Finding } from "../model.js";
import { DEFAULT_EXTERNAL_TIMEOUT_MS, nodeAnalyzerEnvironment, streamProcessEffect, type StreamProcessOptions } from "../process.js";
import { tsconfigFileNames } from "../program.js";
import type { Scope } from "../scope.js";
import { parseDependencyCruiserJson, parseEslintJson, parseKnipOutput } from "./parsers.js";

const OUTPUT_LIMIT_BYTES = 20 * 1024 * 1024;
const MAX_ARGUMENT_BYTES = 128 * 1024;
const slash = (value: string): string => value.replaceAll("\\", "/");
const selectedTsPaths = (cwd: string, scope: Scope): string[] => tsconfigFileNames(cwd)
  .map((file) => slash(relative(cwd, file)))
  .filter((file) => !file.includes("node_modules/") && (scope.mode === "all" || scope.files.includes(file)));

type ExternalProcessRunner = (
  command: string,
  args: readonly string[],
  options: StreamProcessOptions,
) => Effect.Effect<{ stdout: string; stderr: string }, import("../model.js").ProcessError>;

export interface ExternalAnalyzerControls { process?: ExternalProcessRunner }

const parseEffect = (
  analyzer: AnalyzerName,
  label: string,
  operation: () => Finding[],
): Effect.Effect<Finding[], AnalyzerRunError> => Effect.try({
  try: operation,
  catch: (cause) => new AnalyzerRunError({ analyzer, message: `Invalid ${label} output: ${cause instanceof Error ? cause.message : String(cause)}` }),
});

function processOptions(cwd: string, maxMemoryMb: number, timeoutMs: number): StreamProcessOptions {
  return { cwd, timeoutMs, stdoutLimitBytes: OUTPUT_LIMIT_BYTES, stderrLimitBytes: OUTPUT_LIMIT_BYTES, env: nodeAnalyzerEnvironment(maxMemoryMb) };
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

export function eslintAnalyzerEffect(cwd: string, scope: Scope, maxMemoryMb: number, timeoutMs: number = DEFAULT_EXTERNAL_TIMEOUT_MS, controls: ExternalAnalyzerControls = {}): Effect.Effect<Finding[], AnalyzerRunError> {
  const run = controls.process ?? streamProcessEffect;
  return Effect.gen(function* () {
    const script = resolve(cwd, "node_modules/eslint/bin/eslint.js");
    const fixed = [script, "--format", "json", "--"];
    const files = yield* Effect.try({ try: () => selectedTsPaths(cwd, scope), catch: (cause) => new AnalyzerRunError({ analyzer: AnalyzerName.Eslint, message: cause instanceof Error ? cause.message : String(cause) }) });
    const batches = yield* Effect.try({ try: () => argumentBatches(files, fixed), catch: (cause) => new AnalyzerRunError({ analyzer: AnalyzerName.Eslint, message: cause instanceof Error ? cause.message : String(cause) }) });
    const findings: Finding[] = [];
    // analyze: allow-sequential
    for (const batch of batches) {
      const parsed = yield* run(resolve(cwd, "scripts/node-run.sh"), [...fixed, ...batch], processOptions(cwd, maxMemoryMb, timeoutMs)).pipe(
        Effect.flatMap(({ stdout }) => parseEffect(AnalyzerName.Eslint, "ESLint", () => parseEslintJson(stdout, cwd))),
        Effect.catchTag("ProcessError", (cause) => cause.stdout && cause.kind === "exit"
          ? parseEffect(AnalyzerName.Eslint, "ESLint", () => parseEslintJson(cause.stdout!, cwd))
          : Effect.fail(new AnalyzerRunError({ analyzer: AnalyzerName.Eslint, message: cause.message }))),
      );
      findings.push(...parsed);
      yield* Effect.yieldNow();
    }
    return findings;
  });
}

export function dependencyAnalyzerEffect(cwd: string, scope: Scope, maxMemoryMb: number, timeoutMs: number = DEFAULT_EXTERNAL_TIMEOUT_MS, controls: ExternalAnalyzerControls = {}): Effect.Effect<Finding[], AnalyzerRunError> {
  const targets = scope.mode === "all" ? ["."] : scope.files.map((path) => path.startsWith("-") ? `./${path}` : path);
  if (targets.length === 0) return Effect.succeed([]);
  const run = controls.process ?? streamProcessEffect;
  return Effect.gen(function* () {
    const script = resolve(cwd, "node_modules/dependency-cruiser/bin/dependency-cruise.mjs");
    const suffix = ["--output-type", "json", "--progress", "none"];
    const batches = yield* Effect.try({ try: () => argumentBatches(targets, [script, ...suffix]), catch: (cause) => new AnalyzerRunError({ analyzer: AnalyzerName.Dependencies, message: cause instanceof Error ? cause.message : String(cause) }) });
    const findings: Finding[] = [];
    // analyze: allow-sequential
    for (const batch of batches) {
      const parsed = yield* run(resolve(cwd, "scripts/node-run.sh"), [script, ...batch, ...suffix], processOptions(cwd, maxMemoryMb, timeoutMs)).pipe(
        Effect.flatMap(({ stdout }) => parseEffect(AnalyzerName.Dependencies, "dependency-cruiser", () => parseDependencyCruiserJson(stdout))),
        Effect.catchTag("ProcessError", (cause) => cause.stdout
          ? parseEffect(AnalyzerName.Dependencies, "dependency-cruiser", () => parseDependencyCruiserJson(cause.stdout!))
          : Effect.fail(new AnalyzerRunError({ analyzer: AnalyzerName.Dependencies, message: cause.message }))),
      );
      findings.push(...parsed);
      yield* Effect.yieldNow();
    }
    return findings;
  });
}

export function knipAnalyzerEffect(cwd: string, maxMemoryMb: number, timeoutMs: number = DEFAULT_EXTERNAL_TIMEOUT_MS, controls: ExternalAnalyzerControls = {}): Effect.Effect<Finding[], AnalyzerRunError> {
  const run = controls.process ?? streamProcessEffect;
  return run(resolve(cwd, "scripts/node-run.sh"), [resolve(cwd, "node_modules/knip/bin/knip.js"), "--reporter", "compact", "--no-progress", "--no-exit-code"], processOptions(cwd, maxMemoryMb, timeoutMs)).pipe(
    Effect.flatMap(({ stdout, stderr }) => parseEffect(AnalyzerName.Knip, "Knip", () => parseKnipOutput(`${stdout}\n${stderr}`))),
    Effect.mapError((cause) => cause instanceof AnalyzerRunError ? cause : new AnalyzerRunError({ analyzer: AnalyzerName.Knip, message: cause.message })),
  );
}
