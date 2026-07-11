import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { asyncRisksEffect, canonicalizeWithCap, complexityEffect, duplicatesEffect, similarTypesEffect } from "../analyzers.js";
import { BENCHMARK_LIMITS, runBenchmarkEffect, validateBenchmark } from "../benchmark.js";
import { MAX_TOTAL_FINDINGS, analyze, analyzeEffect, capFindings, isMemoryBudgetExceeded, needsInternalProject } from "../engine.js";
import { bundleAnalyzerEffect, dependencyAnalyzerEffect, discoverExtensionEntrypointsEffect, eslintAnalyzerEffect, normalizeBundleMetafile, parseDependencyCruiserJson, parseKnipOutput, parseOxlintJson } from "../external.js";
import { formatResult, shouldFail } from "../format.js";
import { findingId } from "../engine.js";
import { AnalyzerName, FailPolicy, FindingKind, OutputMode, ProcessError, ProcessErrorKind, ScopeMode, Severity, type AnalysisResult, type Finding } from "../model.js";
import { createAnalysisProjectEffect, createProjectEffect, isTypeProject, ProjectRequirement } from "../program.js";
import { analyzerDescriptor, projectRequirement } from "../registry.js";
import { childHeapLimitMb, ProcessServiceLive, processServiceLayer, streamProcessEffect } from "../process.js";
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
    await expect(Effect.runPromise(streamProcessEffect("/bin/echo", ["ok"]))).resolves.toMatchObject({ stdout: "ok\n" });
    const exited = await Effect.runPromise(Effect.either(streamProcessEffect("/bin/false", [])));
    expect(exited._tag === "Left" && exited.left.kind).toBe("exit");
    const timed = await Effect.runPromise(Effect.either(streamProcessEffect("/bin/sleep", ["10"], { timeoutMs: 10 })));
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

  it("retains subprocess stderr in external analyzer failures", async () => {
    const failure = new ProcessError({
      kind: ProcessErrorKind.Exit,
      command: "eslint",
      message: "Process exited with code 2: eslint",
      exitCode: 2,
      stderr: "configuration could not be loaded",
    });
    const cwd = writeProject({ "src/a.ts": "export const a = 1;" });
    const outcome = await Effect.runPromise(Effect.either(eslintAnalyzerEffect(cwd, allScope, 256, 100).pipe(
      Effect.provide(processServiceLayer(() => Effect.fail(failure))),
    )));
    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") expect(outcome.left.message).toContain("stderr: configuration could not be loaded");
  });

  it("adapts EngineSeams.processRunner through ProcessService", async () => {
    const calls: string[] = [];
    const result = await Effect.runPromise(analyzeEffect({ cwd: fixtureRoot(), scope: ScopeMode.All, checks: [AnalyzerName.Knip] }, {
      processRunner: (command) => {
        calls.push(command);
        return Effect.succeed({ stdout: "", stderr: "" });
      },
    }));
    expect(calls).toHaveLength(1);
    expect(result.analyzerFailures).toEqual([]);
  });

  it("preserves typed benchmark failures", async () => {
    const outcome = await Effect.runPromise(Effect.either(runBenchmarkEffect({ command: "/bin/false", args: [], runs: 1 }).pipe(Effect.provide(ProcessServiceLive))));
    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") expect(outcome.left._tag).toBe("BenchmarkError");
  });

  it("keeps repeated benchmark Effect executions independent", async () => {
    const benchmark = runBenchmarkEffect({ command: "echo", args: [], runs: 1 }).pipe(
      Effect.provide(processServiceLayer(() => Effect.succeed({ stdout: "", stderr: "" }))),
    );
    const first = await Effect.runPromise(benchmark);
    const second = await Effect.runPromise(benchmark);
    expect(first.command).toBe(second.command);
    expect(first.runs).toHaveLength(1);
    expect(second.runs).toHaveLength(1);
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

  it("expresses committed and unstaged diff hunks in current worktree lines", async () => {
    const cwd = writeProject({ "src/a.ts": "export const first = 1;\nexport const second = 2;\nexport const third = 3;\n" });
    const git = (...args: string[]): void => { execFileSync("git", args, { cwd, stdio: "ignore" }); };
    git("init", "-b", "main");
    git("config", "user.email", "analyze@example.invalid");
    git("config", "user.name", "Analyze Test");
    git("add", ".");
    git("commit", "-m", "baseline");
    git("switch", "-c", "feature");
    writeFileSync(join(cwd, "src/a.ts"), "export const first = 1;\nexport const second = 2;\nexport const third = 30;\n");
    git("add", ".");
    git("commit", "-m", "change third");
    writeFileSync(join(cwd, "src/a.ts"), "// shifts committed hunk\nexport const first = 1;\nexport const second = 2;\nexport const third = 30;\n");

    const scope = await Effect.runPromise(resolveScopeEffect(cwd, ScopeMode.Diff, [], "main").pipe(Effect.provide(ProcessServiceLive)));
    expect(scope.hunks.get("src/a.ts")).toEqual([
      { start: 1, end: 1 },
      { start: 4, end: 4 },
    ]);
  });

  it("rejects impossible analyzer budgets before capability loading while allowing eligible checks", async () => {
    const cwd = writeProject({ "src/a.ts": "export const a = 1;" });
    let creations = 0;
    let launches = 0;
    const rejectedInternal = await Effect.runPromise(analyzeEffect({
      cwd, scope: ScopeMode.All, maxMemoryMb: 1023, checks: [AnalyzerName.Types],
    }, { createAnalysisProject: () => { creations++; return undefined; } }));
    expect(creations).toBe(0); // preflight rejects before the semantic project is created
    expect(rejectedInternal.analyzerFailures[0]).toMatchObject({ analyzer: AnalyzerName.Types });

    const result = await Effect.runPromise(analyzeEffect({
      cwd, scope: ScopeMode.All, maxMemoryMb: 512, checks: [AnalyzerName.Complexity, AnalyzerName.Types],
    }, {
      createAnalysisProject: () => { creations++; return undefined; },
      processRunner: () => { launches++; return Effect.succeed({ stdout: "", stderr: "" }); },
    }));
    expect(creations).toBe(1); // complexity is accepted exactly at its 512 MiB boundary
    expect(launches).toBe(0);
    expect(result.analyzerFailures).toEqual(expect.arrayContaining([
      expect.objectContaining({ analyzer: AnalyzerName.Types, message: expect.stringContaining("512 MiB") }),
    ]));

    launches = 0;
    const rejectedExternal = await Effect.runPromise(analyzeEffect({
      cwd, scope: ScopeMode.All, maxMemoryMb: 1535, checks: [AnalyzerName.Eslint],
    }, { processRunner: () => { launches++; return Effect.succeed({ stdout: "", stderr: "" }); } }));
    expect(launches).toBe(0); // preflight rejects before Oxlint can be spawned
    expect(rejectedExternal.analyzerFailures[0]).toMatchObject({ analyzer: AnalyzerName.Eslint });

    const external = await Effect.runPromise(analyzeEffect({
      cwd, scope: ScopeMode.All, maxMemoryMb: 1535, checks: [AnalyzerName.Eslint, AnalyzerName.Dependencies],
    }, { processRunner: () => { launches++; return Effect.succeed({ stdout: JSON.stringify({ summary: { violations: [] } }), stderr: "" }); } }));
    expect(launches).toBe(1); // dependencies remains eligible at 768 MiB
    expect(external.analyzerFailures).toEqual(expect.arrayContaining([
      expect.objectContaining({ analyzer: AnalyzerName.Eslint, message: expect.stringContaining("1536 MiB") }),
    ]));
  });

  it("returns all-rejected preflight results before resolving a non-Git scope", async () => {
    const cwd = fixtureRoot();
    const rejected = await Effect.runPromise(analyze({
      cwd, scope: ScopeMode.Diff, maxMemoryMb: 1, checks: [AnalyzerName.Types, AnalyzerName.Eslint],
    }));
    expect(rejected.analyzerFailures).toEqual([
      expect.objectContaining({ analyzer: AnalyzerName.Types, message: expect.stringContaining("1024 MiB") }),
      expect.objectContaining({ analyzer: AnalyzerName.Eslint, message: expect.stringContaining("1536 MiB") }),
    ]);
    expect(rejected.analyzerFailures).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ analyzer: "scope" }),
    ]));
  });

  it("accepts the exact external budget boundary and does not give native Oxlint NODE_OPTIONS", async () => {
    const cwd = writeProject({ "src/a.ts": "export const a = 1;" });
    let invocation: { command: string; args: readonly string[]; options?: import("../process.js").StreamProcessOptions } | undefined;
    const result = await Effect.runPromise(analyzeEffect({
      cwd, scope: ScopeMode.All, maxMemoryMb: 1536, checks: [AnalyzerName.Eslint],
    }, { processRunner: (command, args, options) => { invocation = { command, args, options }; return Effect.succeed({ stdout: JSON.stringify({ diagnostics: [] }), stderr: "" }); } }));
    expect(result.analyzerFailures).toEqual([]);
    expect(invocation?.command).toBe("node");
    expect(invocation?.args[0]).toBe(resolve(cwd, "node_modules/oxlint/bin/oxlint"));
    expect(invocation?.options?.env?.PATH).toMatch(/^\/bin:\/usr\/bin:/);
    expect(invocation?.options?.env?.NODE_OPTIONS).toBeUndefined();
  });

  it("plans external-only runs without creating a Program and profiles only on request", async () => {
    const cwd = writeProject({ "src/a.ts": "export const a = 1;" });
    let creations = 0;
    const plain = await Effect.runPromise(analyze({ cwd, scope: ScopeMode.All, checks: [AnalyzerName.Bundle] }, { createAnalysisProject: () => { creations++; return Effect.die("unexpected project creation"); } }));
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

  it("plans the least expensive project capability for selected analyzers", async () => {
    const cwd = writeProject({
      "src/changed.ts": "export const changed = 1;",
      "src/global.ts": "export const global = 1;",
    });
    const scope = pathScope(["src/changed.ts"]);
    expect(projectRequirement([AnalyzerName.Complexity, AnalyzerName.AsyncRisk])).toBe(ProjectRequirement.ScopedSyntax);
    expect(projectRequirement([AnalyzerName.Complexity, AnalyzerName.Duplicates])).toBe(ProjectRequirement.CorpusSyntax);
    expect(projectRequirement([AnalyzerName.Duplicates, AnalyzerName.Types])).toBe(ProjectRequirement.Types);
    const scoped = (await Effect.runPromise(createAnalysisProjectEffect(cwd, scope, ProjectRequirement.ScopedSyntax)))!;
    const corpus = (await Effect.runPromise(createAnalysisProjectEffect(cwd, scope, ProjectRequirement.CorpusSyntax)))!;
    expect(scoped.files.map((file) => file.fileName)).toHaveLength(1);
    expect(corpus.files.map((file) => file.fileName)).toHaveLength(2);
    expect(isTypeProject(scoped)).toBe(false);
  });

  it("captures internal analyzer exceptions in the typed error channel", async () => {
    const outcome = await Effect.runPromise(Effect.either(analyzerDescriptor(AnalyzerName.Complexity).run({
      cwd: fixtureRoot(), scope: allScope, maxMemoryMb: 256, beforeBundleEntry: () => true,
    }).pipe(Effect.provide(ProcessServiceLive))));
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
  it("reports exact interfaces with different names and near object shapes", async () => {
    const cwd = writeProject({ "src/types.ts": `
      export interface UserDto { id: string; name: string; active: boolean; count: number; }
      export interface AccountDto { id: string; name: string; active: boolean; count: number; }
      export interface NearDto { id: string; name: string; active: boolean; total: number; }
    ` });
    const findings = await Effect.runPromise(similarTypesEffect(await Effect.runPromise(createProjectEffect(cwd)), cwd, allScope, 0.6));
    expect(findings.some((item) => item.message.includes("Exact structural type duplicate: UserDto / AccountDto"))).toBe(true);
    expect(findings.some((item) => item.message.includes("Near structural type duplicate"))).toBe(true);
  });

  it("does not report direct interface inheritance or type aliases as duplicates", async () => {
    const cwd = writeProject({ "src/types.ts": `
      export interface PreflightPlan { budget: number; checks: string[]; }
      export interface AnalysisPlan extends PreflightPlan { scope: string; }
      export type AliasPlan = PreflightPlan;
      export interface NearDto { id: string; name: string; active: boolean; total: number; }
      export interface AlsoNearDto { id: string; name: string; active: boolean; count: number; }
    ` });
    const findings = await Effect.runPromise(similarTypesEffect(await Effect.runPromise(createProjectEffect(cwd)), cwd, allScope, 0.6));
    expect(findings.some((item) => item.message.includes("PreflightPlan / AnalysisPlan"))).toBe(false);
    expect(findings.some((item) => item.message.includes("PreflightPlan / AliasPlan"))).toBe(false);
    expect(findings.some((item) => item.message.includes("Near structural type duplicate"))).toBe(true);
  });

  it("keeps distinct type pairs when declarations share a line", async () => {
    const cwd = writeProject({ "src/types.ts": "export interface A { id: string; name: string } export interface B { id: string; name: string } export interface C { id: string; name: string }" });
    const findings = await Effect.runPromise(similarTypesEffect(await Effect.runPromise(createProjectEffect(cwd)), cwd, allScope));
    expect(findings.map((item) => item.message)).toEqual([
      "Exact structural type duplicate: A / B",
      "Exact structural type duplicate: A / C",
      "Exact structural type duplicate: B / C",
    ]);
  });

  it("compares changed seeds against the global corpus", async () => {
    const cwd = writeProject({
      "src/changed.ts": "export interface ChangedShape { id: string; name: string; active: boolean; count: number; }",
      "src/global.ts": "export interface GlobalShape { id: string; name: string; active: boolean; count: number; }",
    });
    const findings = await Effect.runPromise(similarTypesEffect(await Effect.runPromise(createProjectEffect(cwd)), cwd, pathScope(["src/changed.ts"])));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.related?.[0]?.path).toBe("src/global.ts");
  });

  it("does not match different property types or string literal unions", async () => {
    const cwd = writeProject({ "src/types.ts": `
      export interface StringId { id: string; label: string; }
      export interface NumberId { id: number; label: string; }
      export type Severity = "info" | "warning" | "error";
      export type OtherAlias = "low" | "medium" | "high";
    ` });
    const findings = await Effect.runPromise(similarTypesEffect(await Effect.runPromise(createProjectEffect(cwd)), cwd, allScope, 0.8));
    expect(findings).toHaveLength(0);
  });
});

describe("ast analyzers", () => {
  it("runs internal analyzers through Effect APIs", async () => {
    const cwd = writeProject({ "src/sample.ts": `
      export async function alpha(items: number[]) { for (const item of items) await Promise.resolve(item); return items.length; }
      export async function beta(values: number[]) { for (const value of values) await Promise.resolve(value); return values.length; }
      export interface First { id: string; name: string; active: boolean; }
      export interface Second { id: string; name: string; active: boolean; }
    ` });
    const project = await Effect.runPromise(createProjectEffect(cwd));
    await expect(Effect.runPromise(complexityEffect(project, cwd, allScope))).resolves.toEqual([]);
    await expect(Effect.runPromise(duplicatesEffect(project, cwd, allScope))).resolves.toEqual([]);
    await expect(Effect.runPromise(similarTypesEffect(project, cwd, allScope))).resolves.toHaveLength(1);
    await expect(Effect.runPromise(asyncRisksEffect(project, cwd, allScope))).resolves.toHaveLength(2);
  });

  it("isolates nested function complexity and respects hunk body intersection", async () => {
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
    const findings = await Effect.runPromise(complexityEffect(await Effect.runPromise(createProjectEffect(cwd)), cwd, scope));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.location.line).toBe(7);
  });

  it("does not warn for a small flat boolean predicate", async () => {
    const cwd = writeProject({ "src/flat.ts": `
      export function matches(a: boolean, b: boolean, c: boolean, d: boolean) {
        return a && b && c && d;
      }
    ` });
    await expect(Effect.runPromise(complexityEffect(await Effect.runPromise(createProjectEffect(cwd)), cwd, allScope))).resolves.toEqual([]);
  });

  it("detects renamed duplicate functions, same-file clones, and full canonical traversal", async () => {
    const cwd = writeProject({ "src/dupes.ts": `
      export function alpha(input: number) { const values = [1,2,3,4]; let total = 0; for (const value of values) { if (value > input) total += value * 2; else total += value; } return total; }
      export function beta(other: number) { const values = [1,2,3,4]; let total = 0; for (const value of values) { if (value > other) total += value * 2; else total += value; } return total; }
    ` });
    const findings = await Effect.runPromise(duplicatesEffect(await Effect.runPromise(createProjectEffect(cwd)), cwd, allScope));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.location.line).toBe(2);
    expect(findings[0]?.related).toHaveLength(1);
    expect(findings[0]?.related?.[0]?.line).toBe(3);
  });

  it("keeps reusable analyzer Effects independent", async () => {
    const cwd = writeProject({ "src/reusable.ts": `
      export function complex(value: number) { if (value > 0) { if (value > 1) { if (value > 2) { if (value > 3) { if (value > 4) { if (value > 5) { if (value > 6) { if (value > 7) { if (value > 8) { if (value > 9) { if (value > 10) { if (value > 11) { if (value > 12) { if (value > 13) return value; } } } } } } } } } } } } } } return 0; }
      export function alpha(input: number) { const values = [1,2,3,4]; let total = 0; for (const value of values) { if (value > input) total += value * 2; else total += value; } return total; }
      export function beta(other: number) { const values = [1,2,3,4]; let total = 0; for (const value of values) { if (value > other) total += value * 2; else total += value; } return total; }
      export async function risky(items: number[]) { for (const item of items) await Promise.resolve(item); }
      export interface First { id: string; name: string; }
      export interface Second { id: string; name: string; }
    ` });
    const project = await Effect.runPromise(createProjectEffect(cwd));
    const effects = [
      complexityEffect(project, cwd, allScope),
      asyncRisksEffect(project, cwd, allScope),
      duplicatesEffect(project, cwd, allScope),
      similarTypesEffect(project, cwd, allScope),
    ];
    for (const effect of effects) {
      const first = await Effect.runPromise(effect);
      const second = await Effect.runPromise(effect);
      const concurrent = await Effect.runPromise(Effect.all([effect, effect], { concurrency: "unbounded" }));
      expect(first).not.toEqual([]);
      expect(second).toEqual(first);
      expect(concurrent).toEqual([first, first]);
    }
  });

  it("ignores for-of initializers but finds risks in the body", async () => {
    const cwd = writeProject({ "src/async.ts": `
      export async function work(items: number[]) {
        for (const item of items.filter(Boolean)) {
          await Promise.resolve(item);
          items.sort();
        }
      }
    ` });
    const messages = (await Effect.runPromise(asyncRisksEffect(await Effect.runPromise(createProjectEffect(cwd)), cwd, allScope))).map((item) => item.message);
    expect(messages).not.toContain("filter call inside loop may repeat a scan");
    expect(messages).toContain("Await inside loop may serialize work");
    expect(messages).toContain("sort call inside loop may repeat a scan");
  });

  it("suppresses only a loop immediately led by allow-sequential", async () => {
    const cwd = writeProject({ "src/async.ts": `
      export async function work(items: number[]) {
        // analyze: allow-sequential
        for (const item of items) await Promise.resolve(item);
        for (const item of items) await Promise.resolve(item);
      }
    ` });
    const findings = await Effect.runPromise(asyncRisksEffect(await Effect.runPromise(createProjectEffect(cwd)), cwd, allScope));
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

  it("strictly parses configured Oxlint diagnostics and preserves labels", () => {
    const findings = parseOxlintJson(JSON.stringify({ diagnostics: [
      { code: "typescript(no-floating-promises)", severity: "error", message: "promise", filename: "src/a.ts", labels: [{ span: { line: 2, column: 3 } }, { span: { line: 4, column: 5 } }], related: [{ code: "note", severity: "info", message: "related", filename: "src/b.ts", labels: [{ span: { line: 6, column: 7 } }], related: [] }] },
      { code: "other", severity: "error", message: "ignored", filename: "src/a.ts", labels: [{ span: { line: 1, column: 1 } }], related: [] },
    ] }), "/repo");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ data: { ruleId: "@typescript-eslint/no-floating-promises" }, severity: Severity.Error, location: { path: "src/a.ts", line: 2, column: 3 }, related: [{ path: "src/a.ts", line: 4, column: 5 }, { path: "src/b.ts", line: 6, column: 7 }] });
    expect(() => parseOxlintJson('{"diagnostics":[{}]}', "/repo")).toThrow("Invalid Oxlint diagnostic");
    expect(() => parseDependencyCruiserJson('{"summary":{}}')).toThrow("Invalid dependency-cruiser report");
  });

  it("only recovers documented external-analyzer findings exits", async () => {
    const cwd = writeProject({ "src/a.ts": "async function f() { Promise.resolve(1); }" });
    const oxlintStdout = JSON.stringify({ diagnostics: [{ code: "typescript(no-floating-promises)", severity: "error", message: "promise", filename: "src/a.ts", labels: [{ span: { line: 1, column: 22 } }], related: [] }] });
    const depcruiseStdout = JSON.stringify({ summary: { violations: [{ from: "src/a.ts", to: "src/b.ts", rule: { name: "no-cycle", severity: "error" } }] } });
    const cases = [
      { name: "Oxlint findings exit", effect: eslintAnalyzerEffect(cwd, allScope, 256, 100), error: new ProcessError({ kind: ProcessErrorKind.Exit, command: "oxlint", message: "exit 1", exitCode: 1, stdout: oxlintStdout }), succeeds: true },
      { name: "Oxlint unexpected exit", effect: eslintAnalyzerEffect(cwd, allScope, 256, 100), error: new ProcessError({ kind: ProcessErrorKind.Exit, command: "oxlint", message: "exit 2", exitCode: 2, stdout: oxlintStdout }), succeeds: false },
      { name: "Oxlint timeout", effect: eslintAnalyzerEffect(cwd, allScope, 256, 100), error: new ProcessError({ kind: ProcessErrorKind.Timeout, command: "oxlint", message: "timeout", stdout: oxlintStdout }), succeeds: false },
      { name: "Oxlint output limit", effect: eslintAnalyzerEffect(cwd, allScope, 256, 100), error: new ProcessError({ kind: ProcessErrorKind.OutputLimit, command: "oxlint", message: "limit", stdout: oxlintStdout }), succeeds: false },
      { name: "Oxlint interrupted", effect: eslintAnalyzerEffect(cwd, allScope, 256, 100), error: new ProcessError({ kind: ProcessErrorKind.Interrupted, command: "oxlint", message: "interrupted", stdout: oxlintStdout }), succeeds: false },
      { name: "Oxlint spawn", effect: eslintAnalyzerEffect(cwd, allScope, 256, 100), error: new ProcessError({ kind: ProcessErrorKind.Spawn, command: "oxlint", message: "spawn", stdout: oxlintStdout }), succeeds: false },
      { name: "dependency-cruiser findings stdout on nonzero", effect: dependencyAnalyzerEffect(cwd, allScope, 256, 100), error: new ProcessError({ kind: ProcessErrorKind.Exit, command: "depcruise", message: "exit 1", exitCode: 1, stdout: depcruiseStdout }), succeeds: false },
      { name: "dependency-cruiser timeout", effect: dependencyAnalyzerEffect(cwd, allScope, 256, 100), error: new ProcessError({ kind: ProcessErrorKind.Timeout, command: "depcruise", message: "timeout", stdout: depcruiseStdout }), succeeds: false },
      { name: "dependency-cruiser output limit", effect: dependencyAnalyzerEffect(cwd, allScope, 256, 100), error: new ProcessError({ kind: ProcessErrorKind.OutputLimit, command: "depcruise", message: "limit", stdout: depcruiseStdout }), succeeds: false },
      { name: "dependency-cruiser interrupted", effect: dependencyAnalyzerEffect(cwd, allScope, 256, 100), error: new ProcessError({ kind: ProcessErrorKind.Interrupted, command: "depcruise", message: "interrupted", stdout: depcruiseStdout }), succeeds: false },
      { name: "dependency-cruiser spawn", effect: dependencyAnalyzerEffect(cwd, allScope, 256, 100), error: new ProcessError({ kind: ProcessErrorKind.Spawn, command: "depcruise", message: "spawn", stdout: depcruiseStdout }), succeeds: false },
    ];

    for (const item of cases) {
      const outcome = await Effect.runPromise(Effect.either(item.effect.pipe(
        Effect.provide(processServiceLayer(() => Effect.fail(item.error))),
      )));
      expect(outcome._tag, item.name).toBe(item.succeeds ? "Right" : "Left");
      if (item.succeeds && outcome._tag === "Right") expect(outcome.right).toHaveLength(1);
    }
  });

  it("smoke tests the type-aware Oxlint backend", async () => {
    const cwd = writeProject({ "src/a.ts": "async function f() { Promise.resolve(1); }\nf();" });
    symlinkSync(join(process.cwd(), "node_modules"), join(cwd, "node_modules"), "junction");
    writeFileSync(join(cwd, ".oxlintrc.json"), readFileSync(join(process.cwd(), ".oxlintrc.json")));
    const findings = await Effect.runPromise(eslintAnalyzerEffect(cwd, allScope, 256).pipe(Effect.provide(ProcessServiceLive)));
    expect(findings).toEqual(expect.arrayContaining([expect.objectContaining({ analyzer: AnalyzerName.Eslint, data: { ruleId: "@typescript-eslint/no-floating-promises" } })]));
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
    await expect(Effect.runPromise(discoverExtensionEntrypointsEffect(cwd))).resolves.toEqual([".pi/extensions/alpha/index.ts", ".pi/extensions/beta/index.ts"]);
  });

  it("falls back to discovered entries and empty externals for malformed optional JSON", async () => {
    const cwd = writeProject({ ".pi/extensions/alpha/index.ts": "export const alpha = 1;" });
    writeFileSync(join(cwd, "package.json"), "{");
    writeFileSync(join(cwd, "pi-build.config.json"), "{");
    const findings = await Effect.runPromise(bundleAnalyzerEffect(cwd, allScope, 2048, undefined, {
      build: async (options) => {
        const entry = (options.entryPoints as string[])[0]!;
        return { metafile: { inputs: { [entry]: { bytes: 1, imports: [] } }, outputs: {} } };
      },
    }).pipe(Effect.provide(ProcessServiceLive)));
    expect(findings[0]).toMatchObject({ location: { path: ".pi/extensions/alpha/index.ts" }, data: { externals: [], externalsConfigured: false } });
  });

  it("builds one entrypoint at a time with configured externals", async () => {
    const cwd = writeProject({ ".pi/extensions/a/index.ts": "export const a=1", ".pi/extensions/b/index.ts": "export const b=1" });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ pi: { extensions: [".pi/extensions/a", ".pi/extensions/b"] } }));
    writeFileSync(join(cwd, "pi-build.config.json"), JSON.stringify({ externals: ["pkg-a", "pkg-b"] }));
    const calls: Array<{ entryPoints: readonly string[]; external?: readonly string[] }> = [];
    const findings = await Effect.runPromise(bundleAnalyzerEffect(cwd, allScope, 2048, undefined, { build: async (options) => { calls.push({ entryPoints: options.entryPoints as readonly string[], external: options.external as readonly string[] | undefined }); const entry = (options.entryPoints as string[])[0]!; return { errors: [], warnings: [], metafile: { inputs: { [entry]: { bytes: 1, imports: [] } }, outputs: { "out.js": { bytes: 2, inputs: {}, imports: [], exports: [], entryPoint: entry } } } }; } }).pipe(Effect.provide(ProcessServiceLive)));
    expect(calls).toEqual([{ entryPoints: [".pi/extensions/a/index.ts"], external: ["pkg-a", "pkg-b"] }, { entryPoints: [".pi/extensions/b/index.ts"], external: ["pkg-a", "pkg-b"] }]);
    expect(findings).toHaveLength(2);
    expect(findings.map(item => item.location.path)).toEqual([".pi/extensions/a/index.ts", ".pi/extensions/b/index.ts"]);
  });

  it("maps bundle worker timeouts into typed analyzer failures", async () => {
    const cwd = writeProject({ ".pi/extensions/alpha/index.ts": "export const alpha = 1;" });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ pi: { extensions: [".pi/extensions/alpha"] } }));
    const outcome = await Effect.runPromise(Effect.either(bundleAnalyzerEffect(cwd, allScope, 256, 10).pipe(
      Effect.provide(processServiceLayer((command) => Effect.fail(new ProcessError({ kind: ProcessErrorKind.Timeout, command, message: "timed out" })))),
    )));
    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") expect(outcome.left).toMatchObject({ _tag: "AnalyzerRunError", analyzer: AnalyzerName.Bundle, message: "timed out" });
  });

  it("bundles the owning extension for helper changes but ignores unrelated files", async () => {
    const cwd = writeProject({ ".pi/extensions/alpha/index.ts": "export const alpha = 1;", ".pi/extensions/alpha/helper.ts": "export const helper = 1;", "src/changed.ts": "export const changed = 1;" });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ pi: { extensions: [".pi/extensions/alpha"] } }));
    await expect(Effect.runPromise(bundleAnalyzerEffect(cwd, pathScope(["src/changed.ts"]), 2048).pipe(Effect.provide(ProcessServiceLive)))).resolves.toEqual([]);
    const findings = await Effect.runPromise(bundleAnalyzerEffect(cwd, pathScope([".pi/extensions/alpha/helper.ts"]), 2048).pipe(Effect.provide(ProcessServiceLive)));
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
    const scope = await Effect.runPromise(resolveScopeEffect(cwd, ScopeMode.Paths, ["src", ".pi", "config", "dist", "coverage", "node_modules", ".git", ".analyze-bundle"]).pipe(Effect.provide(ProcessServiceLive)));
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
