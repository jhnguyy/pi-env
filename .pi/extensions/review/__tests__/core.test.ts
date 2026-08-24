import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bound,
  changedLineAnchors,
  confined,
  diffAnchors,
  extractPrUrl,
  marker,
  parseChangedFilesFromDiff,
  parseGitPathList,
  parsePrUrl,
  validateFindingAnchors,
  validatePlan,
  validatePlanShape,
  validateReviewShape,
} from "../core";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("review pull request deterministic contracts", () => {
  it("extracts natural PR URLs for model-facing create selection", () => {
    expect(extractPrUrl("Review this PR https://github.com/acme/widgets/pull/123 please")).toBe(
      "https://github.com/acme/widgets/pull/123",
    );
    expect(
      extractPrUrl("Review this PR https://github.com/acme/widgets/pull/12345678901 please"),
    ).toBeUndefined();
  });

  it("validates strict plan and review shapes", () => {
    expect(
      validatePlanShape({
        goal: "g",
        goalAssessment: "ok",
        risk: "low",
        riskReasons: ["r"],
        cohorts: [{ label: "all", purpose: "p", paths: ["a.ts"] }],
        files: [{ path: "a.ts", attention: "normal", role: "a" }],
        evidence: [
          { kind: "file", path: "a.ts", startLine: 1, endLine: 1, purpose: "review" },
        ],
      }),
    ).toBe(true);
    expect(validatePlanShape({ goal: "", files: [] })).toBe(false);
    expect(
      validatePlanShape({
        goal: "g",
        goalAssessment: "ok",
        risk: "low",
        riskReasons: [],
        cohorts: [{ label: "all", purpose: "p", paths: ["a.ts"] }],
        files: [],
      }),
    ).toBe(false);
    expect(
      validatePlanShape({
        goal: " ",
        goalAssessment: "ok",
        risk: "low",
        riskReasons: [],
        cohorts: [{ label: "all", purpose: "p", paths: ["a.ts"] }],
        files: [{ path: "a.ts", attention: "normal", role: "a" }],
      }),
    ).toBe(false);
    expect(
      validateReviewShape({
        verdict: "v",
        findings: [
          {
            severity: "serious",
            impact: "high",
            file: "a.ts",
            side: "RIGHT",
            line: 1,
            problem: "p",
            consequence: "c",
            suggestedFix: "f",
          },
        ],
      }),
    ).toBe(true);
    expect(
      validateReviewShape({
        verdict: "v",
        findings: [
          {
            severity: "low",
            impact: "low",
            file: "a.ts",
            problem: "p",
            consequence: "c",
            suggestedFix: "f",
          },
        ],
      }),
    ).toBe(true);
    expect(
      validateReviewShape({
        verdict: "v",
        findings: [
          {
            id: "F9",
            severity: "low",
            impact: "low",
            problem: "p",
            consequence: "c",
            suggestedFix: "f",
          },
        ],
      }),
    ).toBe(false);
    expect(
      validateReviewShape({
        verdict: "v",
        findings: [
          {
            severity: "low",
            impact: "low",
            side: "RIGHT",
            line: 1,
            problem: "p",
            consequence: "c",
            suggestedFix: "f",
          },
        ],
      }),
    ).toBe(false);
    expect(
      validateReviewShape({
        verdict: "v",
        findings: [
          {
            severity: "low",
            impact: "low",
            file: "a.ts",
            side: "RIGHT",
            problem: "p",
            consequence: "c",
            suggestedFix: "f",
          },
        ],
      }),
    ).toBe(false);
    expect(
      validateReviewShape({
        verdict: "v",
        findings: [{ severity: "critical", impact: "nit", problem: "p" }],
      }),
    ).toBe(false);
    const finding = {
      severity: "low",
      impact: "low",
      problem: "p",
      consequence: "c",
      suggestedFix: "f",
    };
    expect(validateReviewShape({ verdict: "v", findings: Array(1000).fill(finding) })).toBe(true);
    expect(validateReviewShape({ verdict: "v", findings: Array(1001).fill(finding) })).toBe(false);
  });

  it("validates plan coverage exactly once per changed path", () => {
    const changed = [{ path: "a.ts" }, { path: "b.ts" }];
    expect(
      validatePlan(
        {
          goal: "g",
          goalAssessment: "ok",
          risk: "low",
          riskReasons: [],
          cohorts: [{ label: "all", purpose: "p", paths: ["a.ts", "b.ts"] }],
          files: [
            { path: "a.ts", attention: "normal", role: "a" },
            { path: "b.ts", attention: "normal", role: "b" },
          ],
          evidence: [
            { kind: "file", path: "a.ts", startLine: 1, endLine: 1, purpose: "a" },
            { kind: "diff", path: "b.ts", startLine: 1, endLine: 1, purpose: "b" },
          ],
        },
        changed,
      ).ok,
    ).toBe(true);
    const bad = validatePlan(
      {
        goal: "g",
        goalAssessment: "ok",
        risk: "low",
        riskReasons: [],
        cohorts: [{ label: "all", purpose: "p", paths: ["a.ts", "a.ts", "c.ts"] }],
        files: [
          { path: "a.ts", attention: "normal", role: "a" },
          { path: "a.ts", attention: "normal", role: "dup" },
          { path: "c.ts", attention: "normal", role: "invented" },
        ],
        evidence: [
          { kind: "file", path: "a.ts", startLine: 2, endLine: 1, purpose: "bad" },
          { kind: "diff", path: "c.ts", startLine: 1, endLine: 1, purpose: "invented" },
        ],
      },
      changed,
    );
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("Missing: b.ts");
    expect(bad.message).toContain("Duplicate: a.ts");
    expect(bad.message).toContain("Invented: c.ts");
  });

  it("validates GitHub PR URLs and decodes Git C-style quoted paths", () => {
    expect(parsePrUrl("https://github.com/acme/widgets/pull/123")).toMatchObject({
      owner: "acme",
      repo: "widgets",
      number: 123,
    });
    expect(() => parsePrUrl("https://github.com/-bad/widgets/pull/1")).toThrow(/valid/);
    expect(() => parsePrUrl("https://github.com/../widgets/pull/1")).toThrow(/valid/);
    expect(() => parsePrUrl("https://github.com/%2e%2e/widgets/pull/1")).toThrow(/valid/);
    expect(() => parsePrUrl("https://github.com/acme/widgets/pull/0")).toThrow(/valid/);
    expect(() => parsePrUrl("https://github.com/acme/widgets/pull/12345678901")).toThrow(/valid/);
    expect(parseGitPathList('"a/sp\\303\\244ce\\tname.ts" "b/quote\\" path.ts"')).toEqual([
      "a/späce\tname.ts",
      'b/quote" path.ts',
    ]);
  });

  it("validates RIGHT additions/context and LEFT deletions/context across files and hunks", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,3 @@",
      " one",
      "+two",
      " three",
      "@@ -10,2 +11,2 @@",
      " oldctx",
      "-gone",
      "+new",
      "diff --git a/dir b/part/a.ts b/dir b/part/a.ts",
      "--- a/dir b/part/a.ts",
      "+++ b/dir b/part/a.ts",
      "@@ -1,1 +1,1 @@",
      "+ambiguous",
      'diff --git "a/old\\040name.ts" "b/new\\040name.ts"',
      "--- a/old name.ts",
      "+++ b/new name.ts",
      "@@ -1,1 +1,1 @@",
      "+renamed",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -5,1 +5,1 @@",
      " same",
      "",
    ].join("\n");
    const anchors = diffAnchors(diff);
    expect(anchors.get("a.ts")?.RIGHT.has(2)).toBe(true);
    expect(anchors.get("a.ts")?.RIGHT.has(1)).toBe(true);
    expect(anchors.get("a.ts")?.LEFT.has(11)).toBe(true);
    expect(anchors.get("a.ts")?.LEFT.has(10)).toBe(true);
    expect(anchors.get("b.ts")?.RIGHT.has(5)).toBe(true);
    expect(anchors.get("dir b/part/a.ts")?.RIGHT.has(1)).toBe(true);
    expect(parseChangedFilesFromDiff(diff).map((f) => f.path)).toEqual([
      "a.ts",
      "dir b/part/a.ts",
      "new name.ts",
      "b.ts",
    ]);
  });

  it("preserves invalid anchors unanchored and selects high-impact/blocking/serious only", () => {
    const diff =
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n one\n+two\n three\n";
    expect(changedLineAnchors(diff).get("a.ts")?.has(2)).toBe(true);
    const result = validateFindingAnchors(
      {
        verdict: "comment",
        findings: [
          {
            severity: "medium",
            impact: "high",
            file: "a.ts",
            side: "RIGHT",
            line: 2,
            problem: "p",
            consequence: "c",
            suggestedFix: "f",
          },
          {
            severity: "serious",
            impact: "low",
            file: "a.ts",
            side: "RIGHT",
            line: 99,
            problem: "p2",
            consequence: "c2",
            suggestedFix: "f2",
          },
        ],
      },
      diff,
    );
    expect(result.findings[0]).toMatchObject({
      id: "F1",
      anchorValid: true,
      line: 2,
      selected: true,
    });
    expect(result.findings[1]).toMatchObject({ id: "F2", anchorValid: false, selected: true });
    expect(result.findings[1]?.line).toBeUndefined();
  });

  it("keeps managed paths contained including nested symlink escapes and output bounded", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-pr-review-"));
    const outside = mkdtempSync(join(tmpdir(), "pi-pr-review-outside-"));
    temps.push(root, outside);
    mkdirSync(join(root, "dir"));
    writeFileSync(join(root, "dir", "file.txt"), "ok");
    symlinkSync(outside, join(root, "dir", "escape"));
    expect(confined(root, "dir/file.txt")).toBe(join(root, "dir", "file.txt"));
    expect(() => confined(root, "../x")).toThrow(/escapes|traversal/);
    expect(() => confined(root, "dir/escape")).toThrow(/escapes/);
    expect(bound("abcdef", 3)).toBe("abc\n[truncated 3 chars]");
  });

  it("builds invisible retry markers", () => {
    expect(marker("review", "attempt")).toBe("<!-- pi-env-pr-review:review:attempt -->");
  });
});
