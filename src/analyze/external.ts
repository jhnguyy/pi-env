import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { build, type BuildOptions, type Metafile } from "esbuild";
import { Effect } from "effect";
import {
  AnalyzerName,
  AnalyzerRunError,
  FindingKind,
  Severity,
  type Finding,
} from "./model.js";
import { DEFAULT_EXTERNAL_TIMEOUT_MS, execFileEffect, nodeAnalyzerEnvironment } from "./process.js";
import { tsconfigFileNames } from "./program.js";
import type { Scope } from "./scope.js";

const slash = (value: string): string => value.replaceAll("\\", "/");
const selectedTsPaths = (cwd: string, scope: Scope): string[] =>
  tsconfigFileNames(cwd)
    .map((file) => slash(relative(cwd, file)))
    .filter((file) => !file.includes("node_modules/") && (scope.mode === "all" || scope.files.includes(file)));

interface DependencyViolation {
  from?: string;
  to?: string;
  rule?: { name?: string; severity?: string };
  cycle?: readonly string[];
}

export function parseDependencyCruiserJson(text: string): Finding[] {
  const report = JSON.parse(text) as { summary?: { violations?: readonly DependencyViolation[] } };
  return (report.summary?.violations ?? []).map((violation) => {
    const from = slash(violation.from ?? violation.cycle?.[0] ?? ".");
    const target = violation.to ?? violation.cycle?.[1] ?? "unknown target";
    const severity = violation.rule?.severity === "error" ? Severity.Error : Severity.Warning;
    return {
      id: "",
      analyzer: AnalyzerName.Dependencies,
      kind: FindingKind.Dependency,
      severity,
      message: `${violation.rule?.name ?? "dependency violation"}: ${from} -> ${target}`,
      location: { path: from, line: 1, column: 1 },
      data: { rule: violation.rule?.name, target, cycle: violation.cycle },
    };
  });
}

export function parseKnipOutput(text: string): Finding[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const headings = lines.filter((line) => /^(Unused|Unlisted|Unresolved|Duplicate|Configuration)/i.test(line));
  if (headings.length === 0 && lines.length === 0) {
    return [];
  }
  const message = headings.length > 0
    ? `Knip advisory: ${headings.join("; ")}`
    : `Knip advisory (legacy adapter text): ${lines.slice(0, 5).join("; ")}`;
  return [{
    id: "",
    analyzer: AnalyzerName.Knip,
    kind: FindingKind.Dependency,
    severity: Severity.Warning,
    message,
    location: { path: ".", line: 1, column: 1 },
  }];
}

export interface BundleInputSummary {
  outputBytes: number;
  inputCount: number;
  packageInputCount: number;
  importKinds: Readonly<Record<string, number>>;
}

export function normalizeBundleMetafile(metafile: Metafile): BundleInputSummary {
  const imports: Record<string, number> = {};
  for (const input of Object.values(metafile.inputs)) {
    for (const imported of input.imports) {
      imports[imported.kind] = (imports[imported.kind] ?? 0) + 1;
    }
  }
  return {
    outputBytes: Object.values(metafile.outputs).reduce((total, output) => total + output.bytes, 0),
    inputCount: Object.keys(metafile.inputs).length,
    packageInputCount: Object.keys(metafile.inputs).filter((path) => path.includes("node_modules/")).length,
    importKinds: Object.fromEntries(Object.entries(imports).sort(([a], [b]) => a.localeCompare(b))),
  };
}

interface EslintJsonResult { filePath: string; messages: readonly { ruleId: string | null; severity: number; message: string; line: number; column: number; endLine?: number; endColumn?: number }[] }
const ESLINT_RULES = new Set(["@typescript-eslint/no-floating-promises", "@typescript-eslint/no-misused-promises", "@typescript-eslint/await-thenable"]);
export function parseEslintJson(text: string, cwd: string): Finding[] {
  const results = JSON.parse(text) as readonly EslintJsonResult[];
  return results.flatMap((result) => result.messages.filter((message) => message.ruleId !== null && ESLINT_RULES.has(message.ruleId)).map((message) => ({
    id: "", analyzer: AnalyzerName.Eslint, kind: FindingKind.Lint,
    severity: message.severity === 2 ? Severity.Error : Severity.Warning,
    message: `${message.ruleId}: ${message.message}`,
    location: { path: slash(relative(cwd, result.filePath)), line: message.line, column: message.column, endLine: message.endLine, endColumn: message.endColumn },
    data: { ruleId: message.ruleId },
  })));
}

export function eslintAnalyzerEffect(cwd: string, scope: Scope, maxMemoryMb: number, timeoutMs: number = DEFAULT_EXTERNAL_TIMEOUT_MS): Effect.Effect<Finding[], AnalyzerRunError> {
  const files = selectedTsPaths(cwd, scope);
  if (files.length === 0) return Effect.succeed([]);
  return execFileEffect(resolve(cwd, "scripts/node-run.sh"), [resolve(cwd, "node_modules/eslint/bin/eslint.js"), "--format", "json", "--", ...files], {
    cwd, timeoutMs, maxBuffer: 20 * 1024 * 1024, env: nodeAnalyzerEnvironment(maxMemoryMb),
  }).pipe(
    Effect.map(({ stdout }) => parseEslintJson(stdout, cwd)),
    // ESLint exits 1 when lint findings exist; its JSON is still a successful analyzer result.
    Effect.catchTag("ProcessError", (cause) => cause.stdout && cause.kind === "exit"
      ? Effect.try({ try: () => parseEslintJson(cause.stdout!, cwd), catch: () => new AnalyzerRunError({ analyzer: AnalyzerName.Eslint, message: cause.message }) })
      : Effect.fail(new AnalyzerRunError({ analyzer: AnalyzerName.Eslint, message: cause.message }))),
    Effect.mapError((cause) => cause instanceof AnalyzerRunError ? cause : new AnalyzerRunError({ analyzer: AnalyzerName.Eslint, message: String(cause) })),
  );
}

export function dependencyAnalyzerEffect(cwd: string, scope: Scope, maxMemoryMb: number, timeoutMs: number = DEFAULT_EXTERNAL_TIMEOUT_MS): Effect.Effect<Finding[], AnalyzerRunError> {
  const targets = scope.mode === "all" ? ["."] : scope.files;
  if (targets.length === 0) return Effect.succeed([]);
  const executable = resolve(cwd, "scripts/node-run.sh");
  const script = resolve(cwd, "node_modules/dependency-cruiser/bin/dependency-cruise.mjs");
  return execFileEffect(executable, [script, ...targets, "--output-type", "json", "--progress", "none"], {
    cwd, maxBuffer: 20 * 1024 * 1024, timeoutMs, env: nodeAnalyzerEnvironment(maxMemoryMb),
  }).pipe(
    Effect.map(({ stdout }) => parseDependencyCruiserJson(stdout)),
    Effect.catchTag("ProcessError", (cause) => cause.stdout
      ? Effect.try({ try: () => parseDependencyCruiserJson(cause.stdout!), catch: () => new AnalyzerRunError({ analyzer: AnalyzerName.Dependencies, message: cause.message }) })
      : Effect.fail(new AnalyzerRunError({ analyzer: AnalyzerName.Dependencies, message: cause.message }))),
    Effect.mapError((cause) => cause instanceof AnalyzerRunError ? cause : new AnalyzerRunError({ analyzer: AnalyzerName.Dependencies, message: String(cause) })),
  );
}

export function knipAnalyzerEffect(cwd: string, maxMemoryMb: number, timeoutMs: number = DEFAULT_EXTERNAL_TIMEOUT_MS): Effect.Effect<Finding[], AnalyzerRunError> {
  const executable = resolve(cwd, "scripts/node-run.sh");
  const script = resolve(cwd, "node_modules/knip/bin/knip.js");
  return execFileEffect(executable, [script, "--reporter", "compact", "--no-progress", "--no-exit-code"], {
    cwd, maxBuffer: 20 * 1024 * 1024, timeoutMs, env: nodeAnalyzerEnvironment(maxMemoryMb),
  }).pipe(
    Effect.map(({ stdout, stderr }) => parseKnipOutput(`${stdout}\n${stderr}`)),
    Effect.mapError((cause) => new AnalyzerRunError({ analyzer: AnalyzerName.Knip, message: cause.message })),
  );
}

interface PackageSideEffectsResult {
  sideEffects?: boolean | readonly string[];
  source: "package" | "root" | "missing";
}

async function packageSideEffects(cwd: string, entryPoint: string): Promise<PackageSideEffectsResult> {
  const packageJson = resolve(cwd, dirname(entryPoint), "package.json");
  try {
    const value = JSON.parse(await readFile(packageJson, "utf8")) as { sideEffects?: boolean | readonly string[] };
    if (value.sideEffects !== undefined) return { sideEffects: value.sideEffects, source: "package" };
  } catch {
    // fall through to root metadata
  }
  try {
    const value = JSON.parse(await readFile(resolve(cwd, "package.json"), "utf8")) as { sideEffects?: boolean | readonly string[] };
    if (value.sideEffects !== undefined) return { sideEffects: value.sideEffects, source: "root" };
  } catch {
    // no metadata available
  }
  return { source: "missing" };
}

async function readConfiguredExternals(cwd: string): Promise<{ externals: readonly string[]; configured: boolean }> {
  try {
    const value = JSON.parse(await readFile(resolve(cwd, "pi-build.config.json"), "utf8")) as { externals?: readonly string[] };
    return { externals: Array.isArray(value.externals) ? value.externals : [], configured: Array.isArray(value.externals) };
  } catch {
    return { externals: [], configured: false };
  }
}

interface PackageManifest {
  workspaces?: readonly string[];
  pi?: { extensions?: readonly string[] };
}

async function readPackageManifest(cwd: string): Promise<PackageManifest> {
  try {
    return JSON.parse(await readFile(resolve(cwd, "package.json"), "utf8")) as PackageManifest;
  } catch {
    return {};
  }
}

export async function discoverExtensionEntrypoints(cwd: string): Promise<readonly string[]> {
  const manifest = await readPackageManifest(cwd);
  const registered = [
    ...(manifest.pi?.extensions ?? []),
    ...(manifest.workspaces ?? []).filter((workspace) => workspace.startsWith(".pi/extensions/")),
  ];
  const discovered = existsSync(resolve(cwd, ".pi/extensions"))
    ? (await readdir(resolve(cwd, ".pi/extensions"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => `.pi/extensions/${entry.name}`)
    : [];
  const candidates = [...registered, ...discovered]
    .map((extension) => slash(resolve(cwd, extension, "index.ts")))
    .filter((entry) => existsSync(entry));
  return [...new Set(candidates)]
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
      if (entrypointSet.has(entrypoint) && file === entrypoint) scoped.add(entrypoint);
    }
  }
  return [...scoped].sort();
}

type BundleBuild = (options: BuildOptions) => Promise<{ metafile?: Metafile }>;
interface BundleControls { build?: BundleBuild; beforeEntry?: (entrypoint: string) => boolean }
export async function bundleAnalyzer(cwd: string, scope: Scope, controls: BundleControls = {}): Promise<Finding[]> {
  const entryPoints = scopedExtensionEntrypoints(cwd, scope, await discoverExtensionEntrypoints(cwd));
  const { externals, configured } = await readConfiguredExternals(cwd);
  const findings: Finding[] = [];
  // analyze: allow-sequential
  for (const entryPoint of entryPoints) {
    if (controls.beforeEntry?.(entryPoint) === false) break;
    // esbuild's JS API is non-cancellable; deliberately do not timeout and overlap builds.
    const outputDirectory = await mkdtemp(join(tmpdir(), "pi-analyze-bundle-"));
    let result: { metafile?: Metafile };
    try {
      result = await (controls.build ?? build)({ absWorkingDir: cwd, entryPoints: [entryPoint], bundle: true, write: true, metafile: true, outdir: outputDirectory, platform: "node", format: "esm", external: [...externals] });
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
    const summary = normalizeBundleMetafile(result.metafile!);
    const sideEffects = await packageSideEffects(cwd, entryPoint);
    findings.push({ id: "", analyzer: AnalyzerName.Bundle, kind: FindingKind.Bundle, severity: Severity.Info,
      message: `Bundle: ${summary.outputBytes} bytes, ${summary.inputCount} inputs (${summary.packageInputCount} package inputs)`,
      location: { path: entryPoint, line: 1, column: 1 }, data: { ...summary, ...(sideEffects.sideEffects !== undefined ? { packageSideEffects: sideEffects.sideEffects, treeShakeable: sideEffects.sideEffects === false, sideEffectsSource: sideEffects.source } : { sideEffectsSource: sideEffects.source }), externals, externalsConfigured: configured } });
  }
  return findings;
}
