import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ReviewState } from "../core";
import { makeReviewTools } from "../runtime";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function state(): ReviewState {
  const root = mkdtempSync(join(tmpdir(), "pi-pr-review-root-"));
  temps.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), `${"x".repeat(6000)}\nneedle\n`);
  const artifact = mkdtempSync(join(tmpdir(), "pi-pr-review-art-"));
  temps.push(artifact);
  const diffPath = join(artifact, "diff.patch");
  writeFileSync(
    diffPath,
    "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n same\n+needle\n",
  );
  return {
    snapshot: {
      id: "r",
      artifactDir: artifact,
      worktree: root,
      diffPath,
      diffHash: "h",
      createdAt: "now",
      metadata: {
        owner: "o",
        repo: "r",
        number: 1,
        url: "https://github.com/o/r/pull/1",
        baseOid: "b",
        headOid: "h",
        changedFiles: [{ path: "src/a.ts" }],
      },
    },
    selectedFindingIds: [],
    posts: [],
  };
}

describe("pr-review run-scoped tools", () => {
  it("uses fixed-string grep, exact diff path matching, and bounded large-line reads", async () => {
    let s = state();
    const saved: ReviewState[] = [];
    const tools = Object.fromEntries(
      makeReviewTools({
        get state() {
          return s;
        },
        set state(v) {
          s = v;
        },
        save: (v) => saved.push(v),
      }).map((t) => [t.name, t]),
    );
    expect(
      (
        (await tools.review_grep.execute(
          "1",
          { pattern: "[not-regex", path: "src" } as any,
          undefined as any,
          undefined as any,
        )) as any
      ).content[0].text,
    ).toContain("No matches");
    expect(
      (
        (await tools.review_read.execute(
          "1",
          { path: "src/a.ts" } as any,
          undefined as any,
          undefined as any,
        )) as any
      ).content[0].text.length,
    ).toBeLessThan(13000);
    expect(
      (
        (await tools.review_diff.execute(
          "1",
          { path: "a.ts" } as any,
          undefined as any,
          undefined as any,
        )) as any
      ).content[0].text,
    ).toBe("No diff for path.");
    expect(
      (
        (await tools.review_diff.execute(
          "1",
          { path: "src/a.ts" } as any,
          undefined as any,
          undefined as any,
        )) as any
      ).content[0].text,
    ).toContain("diff --git");
    writeFileSync(
      s.snapshot.diffPath,
      "diff --git a/dir b/part/a.ts b/dir b/part/a.ts\n--- a/dir b/part/a.ts\n+++ b/dir b/part/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
    );
    const ambiguousTools = Object.fromEntries(
      makeReviewTools({ state: s, save: () => {} }).map((tool) => [tool.name, tool]),
    );
    expect(
      (
        (await ambiguousTools.review_diff.execute(
          "2",
          { path: "dir b/part/a.ts" } as any,
          undefined as any,
          undefined as any,
        )) as any
      ).content[0].text,
    ).toContain("dir b/part/a.ts");
  });

  it("pages the complete changed-file manifest beyond prompt and scan limits", async () => {
    const s = state();
    s.snapshot.metadata.changedFiles = Array.from({ length: 1500 }, (_, index) => ({
      path: `src/${index.toString().padStart(5, "0")}-${"x".repeat(20)}.ts`,
    }));
    const tools = Object.fromEntries(
      makeReviewTools({ state: s, save: () => {} }).map((tool) => [tool.name, tool]),
    );
    const first = await tools.review_changed_files.execute(
      "1",
      { page: 1, pageSize: 500 } as any,
      undefined as any,
      undefined as any,
    );
    const last = await tools.review_changed_files.execute(
      "2",
      { page: 3, pageSize: 500 } as any,
      undefined as any,
      undefined as any,
    );
    expect(
      s.snapshot.metadata.changedFiles.map((file) => file.path).join("\n").length,
    ).toBeGreaterThan(24_000);
    expect(JSON.parse((first as any).content[0].text).items).toHaveLength(500);
    expect(JSON.parse((last as any).content[0].text).items.at(-1)).toBe(
      s.snapshot.metadata.changedFiles.at(-1)?.path,
    );
  });

  it("requires accepted plan before submit_review and malformed submissions do not mutate state", async () => {
    let s = state();
    const saved: ReviewState[] = [];
    const tools = Object.fromEntries(
      makeReviewTools({
        get state() {
          return s;
        },
        set state(v) {
          s = v;
        },
        save: (v) => {
          saved.push(v);
          s = v;
        },
      }).map((t) => [t.name, t]),
    );
    const before = JSON.stringify(s);
    expect(
      (
        (await tools.submit_review.execute(
          "1",
          { verdict: "v", findings: [] } as any,
          undefined as any,
          undefined as any,
        )) as any
      ).isError,
    ).toBe(true);
    expect(JSON.stringify(s)).toBe(before);
    expect(
      (
        (await tools.submit_review_plan.execute(
          "1",
          {
            goal: "g",
            goalAssessment: "a",
            risk: "r",
            riskReasons: [],
            cohorts: [{ label: "source", purpose: "Review source", paths: ["src/a.ts"] }],
            files: [{ path: "src/a.ts", attention: "normal", role: "r" }],
          } as any,
          undefined as any,
          undefined as any,
        )) as any
      ).isError,
    ).toBeUndefined();
    expect(
      (
        (await tools.submit_review.execute(
          "1",
          {
            verdict: "v",
            findings: [
              {
                severity: "serious",
                impact: "low",
                problem: "p",
                consequence: "c",
                suggestedFix: "f",
                file: "src/a.ts",
                side: "RIGHT",
                line: 2,
              },
            ],
          } as any,
          undefined as any,
          undefined as any,
        )) as any
      ).isError,
    ).toBeUndefined();
    expect(saved.at(-1)?.selectedFindingIds).toEqual(["F1"]);
  });

  it("accepts explicit zero-finding and file-only unanchored submissions", async () => {
    let s = state();
    const saved: ReviewState[] = [];
    const tools = Object.fromEntries(
      makeReviewTools({
        get state() {
          return s;
        },
        set state(v) {
          s = v;
        },
        save: (v) => {
          saved.push(v);
          s = v;
        },
      }).map((t) => [t.name, t]),
    );
    await tools.submit_review_plan.execute(
      "1",
      {
        goal: "g",
        goalAssessment: "a",
        risk: "r",
        riskReasons: [],
        cohorts: [{ label: "source", purpose: "Review source", paths: ["src/a.ts"] }],
        files: [{ path: "src/a.ts", attention: "normal", role: "r" }],
      } as any,
      undefined as any,
      undefined as any,
    );
    expect(
      (
        (await tools.submit_review.execute(
          "1",
          { verdict: "no issues", findings: [] } as any,
          undefined as any,
          undefined as any,
        )) as any
      ).content[0].text,
    ).toContain("Findings: 0");
    expect(
      (
        (await tools.submit_review.execute(
          "1",
          {
            verdict: "v",
            findings: [
              {
                severity: "low",
                impact: "low",
                file: "src/a.ts",
                problem: "p",
                consequence: "c",
                suggestedFix: "f",
              },
            ],
          } as any,
          undefined as any,
          undefined as any,
        )) as any
      ).isError,
    ).toBeUndefined();
    expect(saved.at(-1)?.result?.findings[0]).toMatchObject({
      id: "F1",
      file: "src/a.ts",
      anchorValid: false,
    });
  });

  it("validates anchors in diff sections after the first 128 KB", async () => {
    let s = state();
    const late = `diff --git a/src/late.ts b/src/late.ts\n--- a/src/late.ts\n+++ b/src/late.ts\n@@ -1,1 +1,2 @@\n old\n+late\n`;
    writeFileSync(s.snapshot.diffPath, `${"x".repeat(140_000)}\n${late}`);
    s = {
      ...s,
      snapshot: {
        ...s.snapshot,
        metadata: { ...s.snapshot.metadata, changedFiles: [{ path: "src/late.ts" }] },
      },
    };
    const tools = Object.fromEntries(
      makeReviewTools({
        get state() {
          return s;
        },
        set state(v) {
          s = v;
        },
        save: (v) => {
          s = v;
        },
      }).map((t) => [t.name, t]),
    );
    expect(
      (
        (await tools.review_diff.execute(
          "1",
          { path: "src/late.ts" } as any,
          undefined as any,
          undefined as any,
        )) as any
      ).content[0].text,
    ).toContain("late.ts");
    await tools.submit_review_plan.execute(
      "1",
      {
        goal: "g",
        goalAssessment: "a",
        risk: "r",
        riskReasons: [],
        cohorts: [{ label: "source", purpose: "Review source", paths: ["src/late.ts"] }],
        files: [{ path: "src/late.ts", attention: "normal", role: "r" }],
      } as any,
      undefined as any,
      undefined as any,
    );
    await tools.submit_review.execute(
      "1",
      {
        verdict: "v",
        findings: [
          {
            severity: "serious",
            impact: "low",
            problem: "p",
            consequence: "c",
            suggestedFix: "f",
            file: "src/late.ts",
            side: "RIGHT",
            line: 2,
          },
        ],
      } as any,
      undefined as any,
      undefined as any,
    );
    expect(s.result?.findings[0]?.anchorValid).toBe(true);
  });

  it("checks cancellation in tool execution", async () => {
    const s = state();
    const tools = makeReviewTools({ state: s, save: () => {} });
    const ac = new AbortController();
    ac.abort();
    await expect(
      tools[0]!.execute("1", { path: "src/a.ts" } as any, ac.signal, undefined as any),
    ).rejects.toThrow(/cancelled/);
  });
});
