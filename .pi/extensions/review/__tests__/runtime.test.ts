import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReviewState } from "../core";
import { createDiffIndex } from "../diff-index";
import { makeReviewReadTools } from "../runtime";

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
        title: "Pinned title",
        body: "Pinned body",
        changedFiles: [{ path: "src/a.ts" }],
      },
    },
    selectedFindingIds: [],
    posts: [],
  };
}

describe("review pull request run-scoped tools", () => {
  it("uses fixed-string grep, exact diff path matching, and bounded large-line reads", async () => {
    let s = state();
    const saved: ReviewState[] = [];
    const tools = Object.fromEntries(
      makeReviewReadTools({
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
    ).toContain("No diff for path.");
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
      makeReviewReadTools({ state: s, save: () => {} }).map((tool) => [tool.name, tool]),
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

  it("pages pinned metadata, late source ranges, and diff sections", async () => {
    const s = state();
    s.snapshot.metadata.body = `start-${"🙂".repeat(20)}-end`;
    const latePath = join(s.snapshot.worktree, "src", "late.ts");
    writeFileSync(
      latePath,
      Array.from({ length: 300 }, (_, index) => `line-${index + 1}`).join("\n"),
    );
    writeFileSync(
      s.snapshot.diffPath,
      [
        "diff --git a/src/late.ts b/src/late.ts",
        "--- a/src/late.ts",
        "+++ b/src/late.ts",
        "@@ -1,1 +1,300 @@",
        ...Array.from({ length: 300 }, (_, index) => `+line-${index + 1}`),
      ].join("\n"),
    );
    const tools = Object.fromEntries(
      makeReviewReadTools({ state: s, save: () => {} }).map((tool) => [tool.name, tool]),
    );
    const metadataFirst = (await tools.review_metadata.execute(
      "metadata-1",
      { offset: 0, maxBytes: 8 },
      undefined,
      undefined as any,
    )) as any;
    const metadataFirstBody = JSON.parse(metadataFirst.content[0].text);
    expect(metadataFirstBody.title).toBe("Pinned title");
    expect(metadataFirstBody.body).not.toContain("�");
    expect(metadataFirst.details.nextOffset).toBeTypeOf("number");
    const source = (await tools.review_read.execute(
      "read-late",
      { path: "src/late.ts", startLine: 200, endLine: 202 },
      undefined,
      undefined as any,
    )) as any;
    expect(source.content[0].text).toBe("line-200\nline-201\nline-202");
    const diffFirst = (await tools.review_diff.execute(
      "diff-1",
      { path: "src/late.ts", maxBytes: 100 },
      undefined,
      undefined as any,
    )) as any;
    const diffSecond = (await tools.review_diff.execute(
      "diff-2",
      { path: "src/late.ts", offset: diffFirst.details.nextOffset, maxBytes: 100 },
      undefined,
      undefined as any,
    )) as any;
    expect(diffFirst.details.hunks).toEqual([
      { startLine: 4, endLine: 304, header: "@@ -1,1 +1,300 @@" },
    ]);
    expect(diffFirst.details.nextOffset).toBeTypeOf("number");
    expect(diffSecond.details.offset).toBe(diffFirst.details.nextOffset);
    expect(diffSecond.content[0].text).not.toBe(diffFirst.content[0].text);
  });

  it("serves the canonical index text and hunk offsets for repeated sections", async () => {
    const s = state();
    const repeated = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-one",
      "+two",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1 +1 @@",
      "-b",
      "+bee",
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -3 +3 @@",
      "-three",
      "+four",
    ].join("\n");
    writeFileSync(s.snapshot.diffPath, repeated);
    const expected = createDiffIndex(repeated).get("src/a.ts");
    const tools = Object.fromEntries(
      makeReviewReadTools({ state: s, save: () => {} }).map((tool) => [tool.name, tool]),
    );
    const result = (await tools.review_diff.execute(
      "repeated",
      { path: "src/a.ts", maxBytes: 12_000 },
      undefined,
      undefined as any,
    )) as any;
    const value = JSON.parse(result.content[0].text);
    expect(value.text).toBe(expected?.text);
    expect(value.hunks).toEqual(expected?.hunks);
  });

  it("pages the complete changed-file manifest beyond prompt and scan limits", async () => {
    const s = state();
    s.snapshot.metadata.changedFiles = Array.from({ length: 1500 }, (_, index) => ({
      path: `src/${index.toString().padStart(5, "0")}-${"x".repeat(20)}.ts`,
    }));
    const tools = Object.fromEntries(
      makeReviewReadTools({ state: s, save: () => {} }).map((tool) => [tool.name, tool]),
    );
    const first = await tools.review_changed_files.execute(
      "1",
      { page: 1, pageSize: 500 },
      undefined,
      undefined as any,
    );
    const last = await tools.review_changed_files.execute(
      "2",
      { page: 3, pageSize: 500 },
      undefined,
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

  it("checks cancellation in tool execution", async () => {
    const s = state();
    const tools = makeReviewReadTools({ state: s, save: () => {} });
    const ac = new AbortController();
    ac.abort();
    await expect(
      tools[0].execute("1", { path: "src/a.ts" } as any, ac.signal, undefined as any),
    ).rejects.toThrow(/cancelled/);
  });
});
