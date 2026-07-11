import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { asyncRisks, asyncRisksEffect, canonicalizeWithCap, complexity, complexityEffect, duplicates, duplicatesEffect, similarTypes, similarTypesEffect } from "../analyzers.js";
import { BENCHMARK_LIMITS, runBenchmarkEffect, validateBenchmark } from "../benchmark.js";
import { MAX_TOTAL_FINDINGS, analyze, analyzeEffect, capFindings, isMemoryBudgetExceeded, needsInternalProject } from "../engine.js";
import { bundleAnalyzer, bundleAnalyzerEffect, discoverExtensionEntrypoints, normalizeBundleMetafile, parseDependencyCruiserJson, parseEslintJson, parseKnipOutput } from "../external.js";
import { formatResult, shouldFail } from "../format.js";
import { findingId } from "../engine.js";
import { AnalyzerName, FailPolicy, FindingKind, OutputMode, ProcessError, ProcessErrorKind, ScopeMode, Severity, type AnalysisResult, type Finding } from "../model.js";
import { createAnalysisProject, createProject, isTypeProject, ProjectRequirement } from "../program.js";
import { projectRequirement, runAnalyzer } from "../registry.js";
import { childHeapLimitMb, execFileEffect, streamProcessEffect } from "../process.js";
import { expandExplicitPathsEffect, intersectsHunks, parseUnifiedHunks, resolveScopeEffect, type Scope } from "../scope.js";

const allScope: Scope = { mode: ScopeMode.All, files: [], hunks: new Map() };
const pathScope = (files: readonly string[], hunks = new Map<string, { start: number; end: number }[]>()): Scope => ({ mode: ScopeMode.Paths, files, hunks });
const fixtureRoot = (): string => mkdtempSync(join(tmpdir(), "pi-analyze-"));

function writeProject(files: Record<string, string>): string {
  const cwd = fixtureRoot();
  writeFileSync(join(cwd, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true }, include: ["src/**/*.ts", ".pi/**/*.ts"] }));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(cwd, file, ".."), { recursive: true });
    writeFileSync(join(cwd, file), text);
  }
  return cwd;
}

const finding: Finding = { id: "", analyzer: AnalyzerName.Complexity, kind: FindingKind.Complexity, severity: Severity.Warning, message: "x", location: { path: "a.ts", line: 2, column: 1 }, related: [{ path: "b.ts", line: 3, column: 1 }] };
const result: AnalysisResult = { version: 1, summary: { info: 0, warning: 1, error: 0, failures: 0 }, findings: [{ ...finding, id: findingId(finding) }], analyzerFailures: [], benchmarks: [] };

describe("analyze contracts", () => {
  it("keeps missing tsconfig typed in analyzeEffect and reports it in analyze", async () => {
    const cwd = fixtureRoot();
    const typed = await Effect.runPromise(Effect.either(analyzeEffect({ cwd, scope: ScopeMode.All })));
    expect(typed._tag).toBe("Left");
    if (typed._tag === "Left") expect(typed.left._tag).toBe("ProgramError");
    const reported = await Effect.runPromise(analyze({ cwd, scope: ScopeMode.All }));
    expect(reported.analyzerFailures[0]?.analyzer).toBe("program");
  });

  it("runs subprocesses and types exit, timeout, and streaming-limit failures", async () => {
    await expect(Effect.runPromise(execFileEffect("/bin/echo", ["ok"]))).resolves.toMatchObject({ stdout: "ok\n" });
    const exited = await Effect.runPromise(Effect.either(execFileEffect("/bin/false", [])));
    expect(exited._tag === "Left" && exited.left.kind).toBe("exit");
    const timed = await Effect.runPromise(Effect.either(execFileEffect("/bin/sleep", ["10"], { timeoutMs: 10 })));
    expect(timed._tag === "Left" && timed.left.kind).toBe("timeout");
    const streamTimed = await Effect.runPromise(Effect.either(streamProcessEffect("/bin/sleep", ["10"], { timeoutMs: 10 })));
    expect(streamTimed._tag === "Left" && streamTimed.left.kind).toBe(ProcessErrorKind.Timeout);
    const limited = await Effect.runPromise(Effect.either(streamProcessEffect("/bin/echo", ["x".repeat(10_000)], { stdoutLimitBytes: 100 })));
    expect(limited._tag === "Left" && limited.left.kind).toBe(ProcessErrorKind.OutputLimit);
    if (limited._tag === "Left") expect(Buffer.byteLength(limited.left.stdout ?? "")).toBeLessThanOrEqual(100);
    const interruptedAt = Date.now();
    const interrupted = await Effect.runPromiseExit(streamProcessEffect("/bin/sleep", ["10"]).pipe(Effect.timeout("20 millis")));
    expect(interrupted._tag).toBe("Failure");
    expect(Date.now() - interruptedAt).toBeLessThan(1_000);
  });

  it("preserves typed benchmark failures", async () => {
    const outcome = await Effect.runPromise(Effect.either(runBenchmarkEffect({ command: "/bin/false", args: [], runs: 1 })));
    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") expect(outcome.left._tag).toBe("BenchmarkError");
  });
  it("creates deterministic related-location IDs and stable formats", () => {
    expect(findingId(finding)).toBe(findingId({ ...finding }));
    expect(formatResult(result, OutputMode.Compact)).toContain("warning\tcomplexity\ta.ts:2:1");
    expect(formatResult(result, OutputMode.Pretty)).toContain("related: b.ts:3:1");
    expect(JSON.parse(formatResult(result, OutputMode.Json)).version).toBe(1);
  });

  it("applies fail policy", () => {
    expect(shouldFail(result, FailPolicy.Warning)).toBe(true);
    expect(shouldFail(result, FailPolicy.Error)).toBe(false);
  });

  it("parses and intersects hunks", () => {
    const hunks = parseUnifiedHunks("+++ b/a.ts\n@@ -1,2 +10,3 @@").get("a.ts");
    expect(hunks).toEqual([{ start: 10, end: 12 }]);
    expect(intersectsHunks(12, 14, hunks)).toBe(true);
    expect(intersectsHunks(1, 9, hunks)).toBe(false);
  });

  it("plans external-only runs without creating a Program and profiles only on request", async () => {
    const cwd = writeProject({ "src/a.ts": "export const a = 1;" });
    let creations = 0;
    const plain = await Effect.runPromise(analyze({ cwd, scope: ScopeMode.All, checks: [AnalyzerName.Bundle] }, { createProject: () => { creations++; return createProject(cwd); } }));
    expect(creations).toBe(0);
    expect(plain.profile).toBeUndefined();
    const profiled = await Effect.runPromise(analyze({ cwd, scope: ScopeMode.All, checks: [], profile: true }));
    expect(profiled.profile?.peak.rssBytes).toBeGreaterThan(0);
    expect(profiled.profile?.timings.scope).toBeGreaterThanOrEqual(0);
    expect(profiled.profile?.memory["after:scope"]?.rssBytes).toBeGreaterThan(0);
    expect(needsInternalProject([AnalyzerName.Eslint, AnalyzerName.Bundle])).toBe(false);
  });

  it("makes deterministic memory and child heap decisions", () => {
    expect(isMemoryBudgetExceeded(101 * 1024 * 1024, 100)).toBe(true);
    expect(isMemoryBudgetExceeded(100 * 1024 * 1024, 100)).toBe(false);
    expect(childHeapLimitMb(2048, 512 * 1024 * 1024)).toBe(1024);
    expect(childHeapLimitMb(1024, 400 * 1024 * 1024)).toBe(112);
  });

  it("plans the least expensive project capability for selected analyzers", () => {
    const cwd = writeProject({
      "src/changed.ts": "export const changed = 1;",
      "src/global.ts": "export const global = 1;",
    });
    const scope = pathScope(["src/changed.ts"]);
    expect(projectRequirement([AnalyzerName.Complexity, AnalyzerName.AsyncRisk])).toBe(ProjectRequirement.ScopedSyntax);
    expect(projectRequirement([AnalyzerName.Complexity, AnalyzerName.Duplicates])).toBe(ProjectRequirement.CorpusSyntax);
    expect(projectRequirement([AnalyzerName.Duplicates, AnalyzerName.Types])).toBe(ProjectRequirement.Types);
    const scoped = createAnalysisProject(cwd, scope, ProjectRequirement.ScopedSyntax)!;
    const corpus = createAnalysisProject(cwd, scope, ProjectRequirement.CorpusSyntax)!;
    expect(scoped.files.map((file) => file.fileName)).toHaveLength(1);
    expect(corpus.files.map((file) => file.fileName)).toHaveLength(2);
    expect(isTypeProject(scoped)).toBe(false);
  });

  it("captures internal analyzer exceptions in the typed error channel", async () => {
    const outcome = await Effect.runPromise(Effect.either(runAnalyzer(AnalyzerName.Complexity, {
      cwd: fixtureRoot(), scope: allScope, maxMemoryMb: 256, beforeBundleEntry: () => true,
    })));
    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") expect(outcome.left).toMatchObject({ _tag: "AnalyzerRunError", analyzer: AnalyzerName.Complexity });
  });

  it("returns structured results for unknown checks and missing tsconfig", async () => {
    const cwd = fixtureRoot();
    const missing = await Effect.runPromise(analyze({ cwd, scope: ScopeMode.All }));
    expect(missing.analyzerFailures[0]?.analyzer).toBe("program");
    const configured = writeProject({ "src/a.ts": "export const a = 1;" });
    const unknown = await Effect.runPromise(analyze({ cwd: configured, scope: ScopeMode.All, checks: ["wat"] }));
    expect(unknown.analyzerFailures[0]?.analyzer).toBe("configuration");
  });
});

describe("structural type similarity", () => {
  it("reports exact interfaces with different names and near object shapes", () => {
    const cwd = writeProject({ "src/types.ts": `
      export interface UserDto { id: string; name: string; active: boolean; count: number; }
      export interface AccountDto { id: string; name: string; active: boolean; count: number; }
      export interface NearDto { id: string; name: string; active: boolean; total: number; }
    ` });
    const findings = similarTypes(createProject(cwd), cwd, allScope, 0.6);
    expect(findings.some((item) => item.message.includes("Exact structural type duplicate: UserDto / AccountDto"))).toBe(true);
    expect(findings.some((item) => item.message.includes("Near structural type duplicate"))).toBe(true);
  });

  it("compares changed seeds against the global corpus", () => {
    const cwd = writeProject({
      "src/changed.ts": "export interface ChangedShape { id: string; name: string; active: boolean; count: number; }",
      "src/global.ts": "export interface GlobalShape { id: string; name: string; active: boolean; count: number; }",
    });
    const findings = similarTypes(createProject(cwd), cwd, pathScope(["src/changed.ts"]));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.related?.[0]?.path).toBe("src/global.ts");
  });

  it("does not match different property types or string literal unions", () => {
    const cwd = writeProject({ "src/types.ts": `
      export interface StringId { id: string; label: string; }
      export interface NumberId { id: number; label: string; }
      export type Severity = "info" | "warning" | "error";
      export type OtherAlias = "low" | "medium" | "high";
    ` });
    const findings = similarTypes(createProject(cwd), cwd, allScope, 0.8);
    expect(findings).toHaveLength(0);
  });
});

describe("ast analyzers", () => {
  it("keeps cooperative analyzer output identical to pure analyzers", async () => {
    const cwd = writeProject({ "src/sample.ts": `
      export async function alpha(items: number[]) { for (const item of items) await Promise.resolve(item); return items.length; }
      export async function beta(values: number[]) { for (const value of values) await Promise.resolve(value); return values.length; }
      export interface First { id: string; name: string; active: boolean; }
      export interface Second { id: string; name: string; active: boolean; }
    ` });
    const project = createProject(cwd);
    await expect(Effect.runPromise(complexityEffect(project, cwd, allScope))).resolves.toEqual(complexity(project, cwd, allScope));
    await expect(Effect.runPromise(duplicatesEffect(project, cwd, allScope))).resolves.toEqual(duplicates(project, cwd, allScope));
    await expect(Effect.runPromise(similarTypesEffect(project, cwd, allScope))).resolves.toEqual(similarTypes(project, cwd, allScope));
    await expect(Effect.runPromise(asyncRisksEffect(project, cwd, allScope))).resolves.toEqual(asyncRisks(project, cwd, allScope));
  });

  it("isolates nested function complexity and respects hunk body intersection", () => {
    const cwd = writeProject({ "src/complex.ts": `
      export function outer(value: number) {
        const inner = () => { if (value > 1) { if (value > 2) { if (value > 3) { return value; } } } return 0; };
        if (value > 0) return inner();
        return 0;
      }
      export function changed(value: number) {
        if (value > 1) {
          if (value > 2) {
            if (value > 3) {
              if (value > 4) {
                if (value > 5) {
                  if (value > 6) return value;
                }
              }
            }
          }
        }
        return 0;
      }
    ` });
    const scope = pathScope(["src/complex.ts"], new Map([["src/complex.ts", [{ start: 8, end: 8 }]]]));
    const findings = complexity(createProject(cwd), cwd, scope);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.location.line).toBe(7);
  });

  it("does not warn for a small flat boolean predicate", () => {
    const cwd = writeProject({ "src/flat.ts": `
      export function matches(a: boolean, b: boolean, c: boolean, d: boolean) {
        return a && b && c && d;
      }
    ` });
    expect(complexity(createProject(cwd), cwd, allScope)).toEqual([]);
  });

  it("detects renamed duplicate functions, same-file clones, and full canonical traversal", () => {
    const cwd = writeProject({ "src/dupes.ts": `
      export function alpha(input: number) { const values = [1,2,3,4]; let total = 0; for (const value of values) { if (value > input) total += value * 2; else total += value; } return total; }
      export function beta(other: number) { const values = [1,2,3,4]; let total = 0; for (const value of values) { if (value > other) total += value * 2; else total += value; } return total; }
    ` });
    const findings = duplicates(createProject(cwd), cwd, allScope);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.location.line).toBe(2);
    expect(findings[0]?.related).toHaveLength(1);
    expect(findings[0]?.related?.[0]?.line).toBe(3);
  });

  it("ignores for-of initializers but finds risks in the body", () => {
    const cwd = writeProject({ "src/async.ts": `
      export async function work(items: number[]) {
        for (const item of items.filter(Boolean)) {
          await Promise.resolve(item);
          items.sort();
        }
      }
    ` });
    const messages = asyncRisks(createProject(cwd), cwd, allScope).map((item) => item.message);
    expect(messages).not.toContain("filter call inside loop may repeat a scan");
    expect(messages).toContain("Await inside loop may serialize work");
    expect(messages).toContain("sort call inside loop may repeat a scan");
  });

  it("suppresses only a loop immediately led by allow-sequential", () => {
    const cwd = writeProject({ "src/async.ts": `
      export async function work(items: number[]) {
        // analyze: allow-sequential
        for (const item of items) await Promise.resolve(item);
        for (const item of items) await Promise.resolve(item);
      }
    ` });
    const findings = asyncRisks(createProject(cwd), cwd, allScope);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toBe("Await inside loop may serialize work");
  });
});

describe("external analyzers and parsers", () => {
  it("parses dependency-cruiser JSON, Knip headings, and bundle metafiles", () => {
    expect(parseDependencyCruiserJson(JSON.stringify({ summary: { violations: [{ from: "src/a.ts", to: "src/b.ts", rule: { name: "no-cycle", severity: "error" } }] } }))[0]?.severity).toBe(Severity.Error);
    expect(parseKnipOutput("Unused files (1)\nUnlisted dependencies (1)")[0]?.message).toContain("Unused files");
    expect(normalizeBundleMetafile({ inputs: { "src/a.ts": { bytes: 1, imports: [{ path: "pkg", kind: "import-statement", external: true }] }, "node_modules/pkg/index.js": { bytes: 2, imports: [] } }, outputs: { "out.js": { bytes: 100, inputs: {}, imports: [], exports: [], entryPoint: "src/a.ts" } } }).packageInputCount).toBe(1);
  });

  it("rejects benchmark runs=0", () => {
    expect(() => validateBenchmark({ command: "echo", args: [], runs: 0 })).toThrow(/runs must be an integer between 1 and 100/);
  });

  it("rejects benchmark timeoutMs=0", () => {
    expect(() => validateBenchmark({ command: "echo", args: [], timeoutMs: 0 })).toThrow(/timeoutMs must be an integer between 1 and 300000/);
  });

  it("rejects benchmark values above bounded limits", () => {
    expect(() => validateBenchmark({ command: "echo", args: [], warmups: BENCHMARK_LIMITS.warmups.max + 1 })).toThrow(/warmups must be an integer between 0 and 10/);
    expect(() => validateBenchmark({ command: "echo", args: [], runs: BENCHMARK_LIMITS.runs.max + 1 })).toThrow(/runs must be an integer between 1 and 100/);
    expect(() => validateBenchmark({ command: "echo", args: [], timeoutMs: BENCHMARK_LIMITS.timeoutMs.max + 1 })).toThrow(/timeoutMs must be an integer between 1 and 300000/);
  });

  it("parses only the configured ESLint rules from structured JSON", () => {
    const findings = parseEslintJson(JSON.stringify([{ filePath: "/repo/src/a.ts", messages: [
      { ruleId: "@typescript-eslint/no-floating-promises", severity: 2, message: "promise", line: 2, column: 3 },
      { ruleId: "other", severity: 2, message: "ignored", line: 1, column: 1 },
    ] }]), "/repo");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: Severity.Error, location: { path: "src/a.ts", line: 2, column: 3 } });
  });
});

describe("bundle entrypoints", () => {
  it("discovers only actual extension index.ts entrypoints", async () => {
    const cwd = writeProject({
      ".pi/extensions/alpha/index.ts": "export const alpha = 1;",
      ".pi/extensions/alpha/helper.ts": "export const helper = 1;",
      ".pi/extensions/beta/index.ts": "export const beta = 1;",
    });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ pi: { extensions: [".pi/extensions/alpha"] }, workspaces: [".pi/extensions/beta"] }));
    await expect(discoverExtensionEntrypoints(cwd)).resolves.toEqual([".pi/extensions/alpha/index.ts", ".pi/extensions/beta/index.ts"]);
  });

  it("builds one entrypoint at a time with configured externals", async () => {
    const cwd = writeProject({ ".pi/extensions/a/index.ts": "export const a=1", ".pi/extensions/b/index.ts": "export const b=1" });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ pi: { extensions: [".pi/extensions/a", ".pi/extensions/b"] } }));
    writeFileSync(join(cwd, "pi-build.config.json"), JSON.stringify({ externals: ["pkg-a", "pkg-b"] }));
    const calls: Array<{ entryPoints: readonly string[]; external?: readonly string[] }> = [];
    const findings = await bundleAnalyzer(cwd, allScope, { build: async (options) => { calls.push({ entryPoints: options.entryPoints as readonly string[], external: options.external as readonly string[] | undefined }); const entry = (options.entryPoints as string[])[0]!; return { errors: [], warnings: [], metafile: { inputs: { [entry]: { bytes: 1, imports: [] } }, outputs: { "out.js": { bytes: 2, inputs: {}, imports: [], exports: [], entryPoint: entry } } } }; } });
    expect(calls).toEqual([{ entryPoints: [".pi/extensions/a/index.ts"], external: ["pkg-a", "pkg-b"] }, { entryPoints: [".pi/extensions/b/index.ts"], external: ["pkg-a", "pkg-b"] }]);
    expect(findings).toHaveLength(2);
    expect(findings.map(item => item.location.path)).toEqual([".pi/extensions/a/index.ts", ".pi/extensions/b/index.ts"]);
  });

  it("maps bundle worker timeouts into typed analyzer failures", async () => {
    const cwd = writeProject({ ".pi/extensions/alpha/index.ts": "export const alpha = 1;" });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ pi: { extensions: [".pi/extensions/alpha"] } }));
    const outcome = await Effect.runPromise(Effect.either(bundleAnalyzerEffect(cwd, allScope, 256, 10, {
      process: (command) => Effect.fail(new ProcessError({ kind: ProcessErrorKind.Timeout, command, message: "timed out" })),
    })));
    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") expect(outcome.left).toMatchObject({ _tag: "AnalyzerRunError", analyzer: AnalyzerName.Bundle, message: "timed out" });
  });

  it("bundles the owning extension for helper changes but ignores unrelated files", async () => {
    const cwd = writeProject({ ".pi/extensions/alpha/index.ts": "export const alpha = 1;", ".pi/extensions/alpha/helper.ts": "export const helper = 1;", "src/changed.ts": "export const changed = 1;" });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ pi: { extensions: [".pi/extensions/alpha"] } }));
    await expect(bundleAnalyzer(cwd, pathScope(["src/changed.ts"]))).resolves.toEqual([]);
    const findings = await bundleAnalyzer(cwd, pathScope([".pi/extensions/alpha/helper.ts"]));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.location.path).toBe(".pi/extensions/alpha/index.ts");
  });
});

describe("bounded hardening", () => {
  it("bounds explicit path walking to analyzable files and skipped directories", async () => {
    const cwd = writeProject({
      "src/a.ts": "export const a = 1;",
      "src/b.md": "ignored",
      "dist/out.ts": "ignored",
      "coverage/out.ts": "ignored",
      "node_modules/pkg/index.ts": "ignored",
      ".git/config.ts": "ignored",
      ".analyze-bundle/out.ts": "ignored",
      ".pi/extensions/demo/index.ts": "export const demo = 1;",
      "config/app.json": "{}",
    });
    const scope = await Effect.runPromise(resolveScopeEffect(cwd, ScopeMode.Paths, ["src", ".pi", "config", "dist", "coverage", "node_modules", ".git", ".analyze-bundle"]));
    expect(scope.files).toEqual([".pi/extensions/demo/index.ts", "config/app.json", "src/a.ts"]);
  });

  it("returns ScopeError when async explicit path walking exceeds limits", async () => {
    const cwd = writeProject({
      "src/a.ts": "export const a = 1;",
      "src/b.ts": "export const b = 1;",
      "src/c.ts": "export const c = 1;",
      "src/d.ts": "export const d = 1;",
    });
    const capped = await Effect.runPromise(Effect.either(expandExplicitPathsEffect(cwd, ["src"], 3)));
    expect(capped._tag === "Left" && capped.left.message).toMatch(/Scope file limit exceeded/);
    const parent = await Effect.runPromise(Effect.either(expandExplicitPathsEffect(cwd, [".."])));
    expect(parent._tag === "Left" && parent.left.message).toMatch(/outside cwd/);
    const absolute = await Effect.runPromise(Effect.either(expandExplicitPathsEffect(cwd, [tmpdir()])));
    expect(absolute._tag === "Left" && absolute.left.message).toMatch(/outside cwd/);
  });

  it("caps duplicate canonicalization by nodes or bytes", () => {
    const source = ts.createSourceFile("sample.ts", `function huge(){${"value + ".repeat(20_000)}1}`, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const fn = source.statements.find(ts.isFunctionDeclaration);
    expect(fn?.body).toBeDefined();
    const result = canonicalizeWithCap(fn!.body!, { nodesPerFunction: 100, bytesPerFunction: 1_000, minimumNodeCount: 1, minimumTokenCount: 1 });
    expect(result.truncated).toBe(true);
    expect(result.nodeCount).toBeGreaterThan(100);
    expect(result.tokenCount).toBeGreaterThan(0);
  });

  it("does not treat tiny generic error-adapter lambdas as duplicate candidates", () => {
    const source = ts.createSourceFile("sample.ts", `
      const toScopeError = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
      const toProgramError = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
    `, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const arrows = source.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => statement.declarationList.declarations)
      .map((declaration) => declaration.initializer)
      .filter((value): value is ts.ArrowFunction => value !== undefined && ts.isArrowFunction(value));
    expect(arrows).toHaveLength(2);
    const left = canonicalizeWithCap(arrows[0]!.body, { nodesPerFunction: 10_000, bytesPerFunction: 256 * 1024, minimumNodeCount: 20, minimumTokenCount: 24 });
    const right = canonicalizeWithCap(arrows[1]!.body, { nodesPerFunction: 10_000, bytesPerFunction: 256 * 1024, minimumNodeCount: 20, minimumTokenCount: 24 });
    expect(left.canonical).toBe(right.canonical);
    expect(left.nodeCount).toBeLessThan(20);
    expect(left.tokenCount).toBeLessThan(24);
  });

  it("caps total findings with explicit truncation metadata", () => {
    const findings: Finding[] = [
      { id: "", analyzer: AnalyzerName.AsyncRisk, kind: FindingKind.AsyncRisk, severity: Severity.Info, message: "finding-0", location: { path: "src/0.ts", line: 1, column: 1 } },
      { id: "", analyzer: AnalyzerName.AsyncRisk, kind: FindingKind.AsyncRisk, severity: Severity.Info, message: "finding-1", location: { path: "src/1.ts", line: 1, column: 1 } },
      { id: "", analyzer: AnalyzerName.AsyncRisk, kind: FindingKind.AsyncRisk, severity: Severity.Info, message: "finding-2", location: { path: "src/2.ts", line: 1, column: 1 } },
    ];
    const capped = capFindings(findings, 2);
    expect(capped.kept.map((item) => item.message)).toEqual(["finding-0", "finding-1"]);
    expect(capped.truncated).toBe(true);
    expect(capped.truncatedCount).toBe(1);
  });
});
