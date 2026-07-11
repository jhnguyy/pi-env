import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildOptions, Metafile } from "esbuild";
import { Effect } from "effect";
import { AnalyzerName, AnalyzerRunError, FindingKind, Severity, type Finding } from "../model.js";
import { DEFAULT_EXTERNAL_TIMEOUT_MS, nodeAnalyzerEnvironment, streamProcessEffect, type StreamProcessOptions } from "../process.js";
import type { Scope } from "../scope.js";
import { normalizeBundleMetafile } from "./parsers.js";
import type { BundleWorkerRequest, BundleWorkerResponse } from "./bundle-protocol.js";

const slash = (value: string): string => value.replaceAll("\\", "/");
const WORKER = fileURLToPath(new URL("../../../scripts/analyze-bundle-worker.ts", import.meta.url));
const NODE_RUNNER = fileURLToPath(new URL("../../../scripts/node-run.sh", import.meta.url));
const BUNDLE_OUTPUT_LIMIT_BYTES = 32 * 1024 * 1024;

interface PackageSideEffectsResult { sideEffects?: boolean | readonly string[]; source: "package" | "root" | "missing" }
interface PackageManifest { workspaces?: readonly string[]; pi?: { extensions?: readonly string[] } }
async function packageSideEffects(cwd: string, entryPoint: string): Promise<PackageSideEffectsResult> {
  // analyze: allow-sequential
  for (const [path, source] of [[resolve(cwd, dirname(entryPoint), "package.json"), "package"], [resolve(cwd, "package.json"), "root"]] as const) {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as { sideEffects?: boolean | readonly string[] };
      if (value.sideEffects !== undefined) return { sideEffects: value.sideEffects, source };
    } catch { /* try fallback */ }
  }
  return { source: "missing" };
}

async function readConfiguredExternals(cwd: string): Promise<{ externals: readonly string[]; configured: boolean }> {
  try {
    const value = JSON.parse(await readFile(resolve(cwd, "pi-build.config.json"), "utf8")) as { externals?: readonly string[] };
    return { externals: Array.isArray(value.externals) ? value.externals : [], configured: Array.isArray(value.externals) };
  } catch { return { externals: [], configured: false }; }
}

async function readPackageManifest(cwd: string): Promise<PackageManifest> {
  try { return JSON.parse(await readFile(resolve(cwd, "package.json"), "utf8")) as PackageManifest; }
  catch { return {}; }
}

export async function discoverExtensionEntrypoints(cwd: string): Promise<readonly string[]> {
  const manifest = await readPackageManifest(cwd);
  const registered = [...(manifest.pi?.extensions ?? []), ...(manifest.workspaces ?? [])]
    .filter((extension) => /^\.pi\/extensions\/[^/]+$/.test(extension));
  const discovered = existsSync(resolve(cwd, ".pi/extensions"))
    ? (await readdir(resolve(cwd, ".pi/extensions"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => `.pi/extensions/${entry.name}`)
    : [];
  return [...new Set([...registered, ...discovered]
    .map((extension) => slash(resolve(cwd, extension, "index.ts")))
    .filter((entry) => existsSync(entry)))]
    .map((entry) => slash(relative(cwd, entry)))
    .sort();
}

function scopedExtensionEntrypoints(cwd: string, scope: Scope, allEntrypoints: readonly string[]): readonly string[] {
  if (scope.mode === "all") return allEntrypoints;
  const entrypointSet = new Set(allEntrypoints);
  const scoped = new Set<string>();
  for (const file of scope.files) {
    if (entrypointSet.has(file)) scoped.add(file);
    const match = /^(\.pi\/extensions\/[^/]+)\//.exec(file);
    if (match !== null) {
      const entrypoint = `${match[1]}/index.ts`;
      if (entrypointSet.has(entrypoint)) scoped.add(entrypoint);
    }
  }
  return [...scoped].sort();
}

type BundleProcessRunner = typeof streamProcessEffect;
type BundleBuild = (options: BuildOptions) => Promise<{ metafile?: Metafile }>;
export interface BundleControls {
  process?: BundleProcessRunner;
  /** Test-only seam; production bundles always execute in a cancellable child. */
  build?: BundleBuild;
  beforeEntry?: (entrypoint: string) => boolean;
}

function workerMetafileEffect(cwd: string, entryPoint: string, externals: readonly string[], maxMemoryMb: number, timeoutMs: number, processRunner: BundleProcessRunner): Effect.Effect<Metafile, AnalyzerRunError> {
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "pi-analyze-bundle-")),
      catch: (cause) => new AnalyzerRunError({ analyzer: AnalyzerName.Bundle, message: cause instanceof Error ? cause.message : String(cause) }),
    }),
    (outputDirectory) => {
      const request: BundleWorkerRequest = { version: 1, cwd, entryPoint, externals, outputDirectory };
      const options: StreamProcessOptions = { cwd, env: nodeAnalyzerEnvironment(maxMemoryMb), timeoutMs, stdin: `${JSON.stringify(request)}\n`, stdoutLimitBytes: BUNDLE_OUTPUT_LIMIT_BYTES, stderrLimitBytes: BUNDLE_OUTPUT_LIMIT_BYTES };
      return processRunner(NODE_RUNNER, [WORKER], options).pipe(
        Effect.flatMap(({ stdout }) => Effect.try({
          try: () => {
            const response = JSON.parse(stdout) as Partial<BundleWorkerResponse> & { message?: string };
            if (response.version !== 1 || response.ok !== true || response.metafile === undefined) throw new Error(response.message ?? "invalid worker response");
            return response.metafile;
          },
          catch: (cause) => new AnalyzerRunError({ analyzer: AnalyzerName.Bundle, message: `Invalid bundle worker output: ${cause instanceof Error ? cause.message : String(cause)}` }),
        })),
        Effect.mapError((cause) => cause instanceof AnalyzerRunError ? cause : new AnalyzerRunError({ analyzer: AnalyzerName.Bundle, message: [cause.message, cause.stderr?.trim()].filter(Boolean).join("\n") })),
      );
    },
    (outputDirectory) => Effect.promise(() => rm(outputDirectory, { recursive: true, force: true })),
  );
}

export function bundleAnalyzerEffect(cwd: string, scope: Scope, maxMemoryMb: number, timeoutMs: number = DEFAULT_EXTERNAL_TIMEOUT_MS, controls: BundleControls = {}): Effect.Effect<Finding[], AnalyzerRunError> {
  return Effect.gen(function* () {
    const entryPoints = scopedExtensionEntrypoints(cwd, scope, yield* Effect.tryPromise({
      try: () => discoverExtensionEntrypoints(cwd),
      catch: (cause) => new AnalyzerRunError({ analyzer: AnalyzerName.Bundle, message: cause instanceof Error ? cause.message : String(cause) }),
    }));
    const { externals, configured } = yield* Effect.tryPromise({
      try: () => readConfiguredExternals(cwd),
      catch: (cause) => new AnalyzerRunError({ analyzer: AnalyzerName.Bundle, message: cause instanceof Error ? cause.message : String(cause) }),
    });
    const findings: Finding[] = [];
    // analyze: allow-sequential
    for (const entryPoint of entryPoints) {
      if (controls.beforeEntry?.(entryPoint) === false) break;
      const metafile = controls.build === undefined
        ? yield* workerMetafileEffect(cwd, entryPoint, externals, maxMemoryMb, timeoutMs, controls.process ?? streamProcessEffect)
        : yield* Effect.tryPromise({
          try: () => controls.build!({ absWorkingDir: cwd, entryPoints: [entryPoint], bundle: true, write: false, metafile: true, platform: "node", format: "esm", external: [...externals] }).then((result) => result.metafile!),
          catch: (cause) => new AnalyzerRunError({ analyzer: AnalyzerName.Bundle, message: cause instanceof Error ? cause.message : String(cause) }),
        });
      const summary = normalizeBundleMetafile(metafile);
      const sideEffects = yield* Effect.tryPromise({
        try: () => packageSideEffects(cwd, entryPoint),
        catch: (cause) => new AnalyzerRunError({ analyzer: AnalyzerName.Bundle, message: cause instanceof Error ? cause.message : String(cause) }),
      });
      findings.push({
        id: "", analyzer: AnalyzerName.Bundle, kind: FindingKind.Bundle, severity: Severity.Info,
        message: `Bundle: ${summary.outputBytes} bytes, ${summary.inputCount} inputs (${summary.packageInputCount} package inputs)`,
        location: { path: entryPoint, line: 1, column: 1 },
        data: { ...summary, ...(sideEffects.sideEffects !== undefined ? { packageSideEffects: sideEffects.sideEffects, treeShakeable: sideEffects.sideEffects === false, sideEffectsSource: sideEffects.source } : { sideEffectsSource: sideEffects.source }), externals, externalsConfigured: configured },
      });
      yield* Effect.yieldNow();
    }
    return findings;
  });
}

export function bundleAnalyzer(cwd: string, scope: Scope, controls: BundleControls = {}): Promise<Finding[]> {
  return Effect.runPromise(bundleAnalyzerEffect(cwd, scope, 2048, DEFAULT_EXTERNAL_TIMEOUT_MS, controls));
}
