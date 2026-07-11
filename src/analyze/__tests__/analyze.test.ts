import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { asyncRisks, complexity, duplicates, similarTypes } from "../analyzers.js";
import { validateBenchmark } from "../benchmark.js";
import { analyze, isMemoryBudgetExceeded, needsInternalProgram } from "../engine.js";
import { bundleAnalyzer, discoverExtensionEntrypoints, eslintAnalyzer, normalizeBundleMetafile, parseDependencyCruiserJson, parseKnipOutput } from "../external.js";
import { formatResult, shouldFail } from "../format.js";
import { findingId } from "../engine.js";
import { AnalyzerName, FailPolicy, FindingKind, OutputMode, ScopeMode, Severity, type AnalysisResult, type Finding } from "../model.js";
import { createProject } from "../program.js";
import { intersectsHunks, parseUnifiedHunks, type Scope } from "../scope.js";

const repo = resolve(import.meta.dirname, "../../../");
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
    expect(needsInternalProgram([AnalyzerName.Eslint, AnalyzerName.Bundle])).toBe(false);
  });

  it("makes deterministic memory budget decisions", () => {
    expect(isMemoryBudgetExceeded(101 * 1024 * 1024, 100)).toBe(true);
    expect(isMemoryBudgetExceeded(100 * 1024 * 1024, 100)).toBe(false);
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
  it("isolates nested function complexity and respects hunk body intersection", () => {
    const cwd = writeProject({ "src/complex.ts": `
      export function outer(value: number) {
        const inner = () => { if (value > 1) { if (value > 2) { if (value > 3) { return value; } } } return 0; };
        if (value > 0) return inner();
        return 0;
      }
      export function changed(value: number) {
        if (value > 1) {}
        if (value > 2) {}
        if (value > 3) {}
        if (value > 4) {}
        if (value > 5) {}
        if (value > 6) {}
        if (value > 7) {}
        if (value > 8) {}
        if (value > 9) {}
        return value;
      }
    ` });
    const scope = pathScope(["src/complex.ts"], new Map([["src/complex.ts", [{ start: 8, end: 8 }]]]));
    const findings = complexity(createProject(cwd), cwd, scope);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.location.line).toBe(7);
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

  it("detects await and repeated scans inside loops", () => {
    const cwd = writeProject({ "src/async.ts": `
      export async function work(items: number[]) { for (const item of items) { await Promise.resolve(item); items.sort(); } }
    ` });
    const messages = asyncRisks(createProject(cwd), cwd, allScope).map((item) => item.message);
    expect(messages).toContain("Await inside loop may serialize work");
    expect(messages).toContain("sort call inside loop may repeat a scan");
  });
});

describe("external analyzers and parsers", () => {
  it("parses dependency-cruiser JSON, Knip headings, and bundle metafiles", () => {
    expect(parseDependencyCruiserJson(JSON.stringify({ summary: { violations: [{ from: "src/a.ts", to: "src/b.ts", rule: { name: "no-cycle", severity: "error" } }] } }))[0]?.severity).toBe(Severity.Error);
    expect(parseKnipOutput("Unused files (1)\nUnlisted dependencies (1)")[0]?.message).toContain("Unused files");
    expect(normalizeBundleMetafile({ inputs: { "src/a.ts": { bytes: 1, imports: [{ path: "pkg", kind: "import-statement", external: true }] }, "node_modules/pkg/index.js": { bytes: 2, imports: [] } }, outputs: { "out.js": { bytes: 100, inputs: {}, imports: [], exports: [], entryPoint: "src/a.ts" } } }).packageInputCount).toBe(1);
  });

  it("rejects benchmark runs=0", () => {
    expect(() => validateBenchmark({ command: "echo", args: [], runs: 0 })).toThrow(/runs must be an integer >= 1/);
  });

  it("finds ESLint floating promises from a fixture", async () => {
    const cwd = writeProject({ "src/floating.ts": "async function f() {}\nexport function g() { f(); }\n" });
    const tseslint = pathToFileURL(join(repo, "node_modules/typescript-eslint/dist/index.js")).href;
    writeFileSync(join(cwd, "eslint.config.js"), `import tseslint from ${JSON.stringify(tseslint)}; export default tseslint.config({ files:["**/*.ts"], languageOptions:{parser:tseslint.parser,parserOptions:{project:"./tsconfig.json",tsconfigRootDir:import.meta.dirname}}, plugins:{"@typescript-eslint":tseslint.plugin}, rules:{"@typescript-eslint/no-floating-promises":"error"} });`);
    const findings = await eslintAnalyzer(cwd, allScope);
    expect(findings.some((item) => item.message.includes("no-floating-promises"))).toBe(true);
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

  it("does not bundle arbitrary changed TS files and returns no finding with no extension in scope", async () => {
    const cwd = writeProject({ ".pi/extensions/alpha/index.ts": "export const alpha = 1;", ".pi/extensions/alpha/helper.ts": "export const helper = 1;", "src/changed.ts": "export const changed = 1;" });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ pi: { extensions: [".pi/extensions/alpha"] } }));
    await expect(bundleAnalyzer(cwd, pathScope(["src/changed.ts", ".pi/extensions/alpha/helper.ts"]))).resolves.toEqual([]);
    const findings = await bundleAnalyzer(cwd, pathScope([".pi/extensions/alpha/index.ts"]));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.location.path).toBe(".pi/extensions/alpha/index.ts");
  });
});
