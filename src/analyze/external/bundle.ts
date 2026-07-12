import { access } from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildOptions, Metafile } from "esbuild";
import { Effect } from "effect";
import { AnalyzerName, AnalyzerRunError, FindingKind, Severity, type Finding } from "../model.js";
import { DEFAULT_EXTERNAL_TIMEOUT_MS, nodeAnalyzerEnvironment, ProcessService, type StreamProcessOptions } from "../process.js";
import type { Scope } from "../scope.js";
import { normalizeBundleMetafile } from "./parsers.js";
import type { BundleWorkerRequest, BundleWorkerResponse } from "./bundle-protocol.js";

const slash = (value: string): string => value.replaceAll("\\", "/");
const WORKER = fileURLToPath(new URL("../../../scripts/analyze-bundle-worker.ts", import.meta.url));
const NODE_RUNNER = fileURLToPath(new URL("../../../scripts/node-run.sh", import.meta.url));
const BUNDLE_OUTPUT_LIMIT_BYTES = 32 * 1024 * 1024;

interface PackageSideEffectsResult { sideEffects?: boolean | readonly string[]; source: "package" | "root" | "missing" }
interface PackageManifest { workspaces?: readonly string[]; pi?: { extensions?: readonly string[] } }

/** Missing or malformed optional JSON deliberately behaves like an absent configuration. */
function readJsonOrEffect<A>(path: string, fallback: A): Effect.Effect<A> {
  return Effect.tryPromise(() => readFile(path, "utf8").then((text) => JSON.parse(text) as A)).pipe(
    Effect.catch(() => Effect.succeed(fallback)),
  );
}

function fileExistsEffect(path: string): Effect.Effect<boolean> {
  return Effect.tryPromise(() => access(path)).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );
}

function extensionDirectoriesEffect(cwd: string): Effect.Effect<readonly string[]> {
  return Effect.tryPromise(() => readdir(resolve(cwd, ".pi/extensions"), { withFileTypes: true })).pipe(
    Effect.map((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => `.pi/extensions/${entry.name}`)),
    Effect.catch(() => Effect.succeed<readonly string[]>([])),
  );
}

function packageSideEffectsEffect(cwd: string, entryPoint: string): Effect.Effect<PackageSideEffectsResult> {
  return Effect.gen(function* () {
    // analyze: allow-sequential
    for (const [path, source] of [[resolve(cwd, dirname(entryPoint), "package.json"), "package"], [resolve(cwd, "package.json"), "root"]] as const) {
      const value = yield* readJsonOrEffect<{ sideEffects?: boolean | readonly string[] }>(path, {});
      if (value.sideEffects !== undefined) return { sideEffects: value.sideEffects, source };
    }
    return { source: "missing" };
  });
}

function readConfiguredExternalsEffect(cwd: string): Effect.Effect<{ externals: readonly string[]; configured: boolean }> {
  return Effect.map(readJsonOrEffect<{ externals?: readonly string[] }>(resolve(cwd, "pi-build.config.json"), {}), (value) => ({
    externals: Array.isArray(value.externals) ? value.externals : [],
    configured: Array.isArray(value.externals),
  }));
}

function readPackageManifestEffect(cwd: string): Effect.Effect<PackageManifest> {
  return readJsonOrEffect<PackageManifest>(resolve(cwd, "package.json"), {});
}

export function discoverExtensionEntrypointsEffect(cwd: string): Effect.Effect<readonly string[]> {
  return Effect.gen(function* () {
    const manifest = yield* readPackageManifestEffect(cwd);
    const registered = [...(manifest.pi?.extensions ?? []), ...(manifest.workspaces ?? [])]
      .filter((extension) => /^\.pi\/extensions\/[^/]+$/.test(extension));
    const discovered = yield* extensionDirectoriesEffect(cwd);
    const candidates = [...new Set([...registered, ...discovered]
      .map((extension) => slash(resolve(cwd, extension, "index.ts"))))];
    const entries = yield* Effect.forEach(candidates, (entry) => Effect.map(fileExistsEffect(entry), (exists) => exists ? entry : undefined));
    return entries
      .filter((entry): entry is string => entry !== undefined)
      .map((entry) => slash(relative(cwd, entry)))
      .sort();
  });
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

type BundleBuild = (options: BuildOptions) => Promise<{ metafile?: Metafile }>;
export interface BundleControls {
  /** Test-only seam; production bundles always execute in a cancellable child. */
  build?: BundleBuild;
  beforeEntry?: (entrypoint: string) => boolean;
}

const bundleError = (cause: unknown): AnalyzerRunError => new AnalyzerRunError({
  analyzer: AnalyzerName.Bundle,
  message: cause instanceof Error ? cause.message : String(cause),
});

function workerMetafileEffect(cwd: string, entryPoint: string, externals: readonly string[], maxMemoryMb: number, timeoutMs: number): Effect.Effect<Metafile, AnalyzerRunError, ProcessService> {
  return Effect.acquireUseRelease(
    Effect.tryPromise({ try: () => mkdtemp(join(tmpdir(), "pi-analyze-bundle-")), catch: bundleError }),
    (outputDirectory) => {
      const request: BundleWorkerRequest = { version: 1, cwd, entryPoint, externals, outputDirectory };
      const options: StreamProcessOptions = { cwd, env: nodeAnalyzerEnvironment(maxMemoryMb), timeoutMs, stdin: `${JSON.stringify(request)}\n`, stdoutLimitBytes: BUNDLE_OUTPUT_LIMIT_BYTES, stderrLimitBytes: BUNDLE_OUTPUT_LIMIT_BYTES };
      return Effect.flatMap(ProcessService, ({ run }) => run(NODE_RUNNER, [WORKER], options)).pipe(
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
    // Cleanup is best-effort, matching the previous force-remove behavior.
    (outputDirectory) => Effect.tryPromise(() => rm(outputDirectory, { recursive: true, force: true })).pipe(Effect.catch(() => Effect.void)),
  );
}

export function bundleAnalyzerEffect(cwd: string, scope: Scope, maxMemoryMb: number, timeoutMs: number = DEFAULT_EXTERNAL_TIMEOUT_MS, controls: BundleControls = {}): Effect.Effect<Finding[], AnalyzerRunError, ProcessService> {
  return Effect.gen(function* () {
    const entryPoints = scopedExtensionEntrypoints(cwd, scope, yield* discoverExtensionEntrypointsEffect(cwd));
    const { externals, configured } = yield* readConfiguredExternalsEffect(cwd);
    const findings: Finding[] = [];
    // analyze: allow-sequential
    for (const entryPoint of entryPoints) {
      if (controls.beforeEntry?.(entryPoint) === false) break;
      const metafile = controls.build === undefined
        ? yield* workerMetafileEffect(cwd, entryPoint, externals, maxMemoryMb, timeoutMs)
        : yield* Effect.tryPromise({
          try: () => controls.build!({ absWorkingDir: cwd, entryPoints: [entryPoint], bundle: true, write: false, metafile: true, platform: "node", format: "esm", external: [...externals] }).then((result) => result.metafile!),
          catch: bundleError,
        });
      const summary = normalizeBundleMetafile(metafile);
      const sideEffects = yield* packageSideEffectsEffect(cwd, entryPoint);
      findings.push({
        id: "", analyzer: AnalyzerName.Bundle, kind: FindingKind.Bundle, severity: Severity.Info,
        message: `Bundle: ${summary.outputBytes} bytes, ${summary.inputCount} inputs (${summary.packageInputCount} package inputs)`,
        location: { path: entryPoint, line: 1, column: 1 },
        data: { ...summary, ...(sideEffects.sideEffects !== undefined ? { packageSideEffects: sideEffects.sideEffects, treeShakeable: sideEffects.sideEffects === false, sideEffectsSource: sideEffects.source } : { sideEffectsSource: sideEffects.source }), externals, externalsConfigured: configured },
      });
      yield* Effect.yieldNow;
    }
    return findings;
  });
}
