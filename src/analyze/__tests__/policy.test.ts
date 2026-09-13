import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnalyzerName, ScopeMode } from "../model.js";
import {
  ANALYZE_LIMITS,
  classifyAnalyzeRequest,
  type PublicAnalyzeRequest,
} from "../policy.js";

const fixtureRoot = (): string => mkdtempSync(join(tmpdir(), "pi-analyze-policy-"));

describe("safe analyze policy", () => {
  it("parses safe checks with diff or bounded relative paths", () => {
    const cwd = fixtureRoot();
    expect(
      classifyAnalyzeRequest({
        cwd,
        scope: ScopeMode.Diff,
        ref: "main",
        checks: [AnalyzerName.Complexity, AnalyzerName.AsyncRisk],
        maxMemoryMb: 8_192,
      }),
    ).toMatchObject({
      _tag: "safe",
      request: {
        scope: ScopeMode.Diff,
        ref: "main",
        maxMemoryMb: 512,
        checks: ["complexity", "async-risk"],
      },
    });
    expect(
      classifyAnalyzeRequest({
        cwd,
        scope: ScopeMode.Paths,
        paths: ["src/a.ts"],
        checks: [AnalyzerName.Duplicates],
        maxMemoryMb: 8_192,
      }),
    ).toMatchObject({
      _tag: "safe",
      request: {
        scope: ScopeMode.Paths,
        paths: ["src/a.ts"],
        maxMemoryMb: 512,
        maxSourceFiles: ANALYZE_LIMITS.sourceFiles,
        maxSourceFileBytes: ANALYZE_LIMITS.sourceFileBytes,
        maxSourceBytes: ANALYZE_LIMITS.sourceBytes,
      },
    });
    for (const check of [AnalyzerName.TestDuplicates, AnalyzerName.AsyncRisk]) {
      expect(
        classifyAnalyzeRequest({
          cwd,
          scope: ScopeMode.Paths,
          paths: ["src/a.test.ts"],
          checks: [check],
        }),
      ).toMatchObject({ _tag: "safe" });
    }
  });

  it("rejects invalid or contradictory scope selections", () => {
    const cwd = fixtureRoot();
    for (const path of [
      "../outside.ts",
      "src/../../outside.ts",
      "src\\..\\outside.ts",
      "C:outside.ts",
    ]) {
      expect(
        classifyAnalyzeRequest({
          cwd,
          scope: ScopeMode.Paths,
          paths: [path],
          checks: [AnalyzerName.AsyncRisk],
        }),
      ).toMatchObject({ _tag: "invalid" });
    }
    const invalidRequests: readonly PublicAnalyzeRequest[] = [
      { cwd, scope: ScopeMode.Diff, paths: [], checks: [AnalyzerName.Complexity] },
      {
        cwd,
        scope: ScopeMode.Paths,
        paths: ["src/a.ts"],
        ref: "main",
        checks: [AnalyzerName.Complexity],
      },
      {
        cwd,
        scope: ScopeMode.Paths,
        paths: ["src/a.ts", "src/a.ts"],
        checks: [AnalyzerName.Complexity],
      },
      { cwd, scope: ScopeMode.All, paths: ["src/a.ts"], checks: [AnalyzerName.Types] },
      { cwd, scope: ScopeMode.All, ref: "main", checks: [AnalyzerName.Types] },
    ];
    for (const request of invalidRequests) {
      expect(classifyAnalyzeRequest(request)).toMatchObject({ _tag: "invalid" });
    }
  });

  it("fails closed for invalid checks and classifies valid heavy work as strict", () => {
    const cwd = fixtureRoot();
    expect(classifyAnalyzeRequest({ cwd })).toMatchObject({ _tag: "invalid" });
    expect(
      classifyAnalyzeRequest({ cwd, checks: [AnalyzerName.Complexity, AnalyzerName.Complexity] }),
    ).toMatchObject({ _tag: "invalid" });
    expect(classifyAnalyzeRequest({ cwd, checks: ["unknown"] })).toMatchObject({
      _tag: "invalid",
    });
    expect(
      classifyAnalyzeRequest({ cwd, scope: ScopeMode.All, checks: [AnalyzerName.Complexity] }),
    ).toMatchObject({ _tag: "strict" });
    expect(classifyAnalyzeRequest({ cwd, checks: [AnalyzerName.Types] })).toMatchObject({
      _tag: "strict",
    });
    expect(
      classifyAnalyzeRequest({ cwd, checks: [AnalyzerName.Complexity], profile: true }),
    ).toMatchObject({ _tag: "strict" });
    expect(
      classifyAnalyzeRequest({
        cwd,
        checks: [AnalyzerName.Complexity],
        ref: "--upload-pack=malicious",
      }),
    ).toMatchObject({ _tag: "invalid" });
  });
});
