import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256, type ReviewState } from "../core";
import { buildReviewReadToolContracts, type ReviewRunStore } from "../runtime";
import { readVerifiedPinnedDiff } from "../snapshot";

const temps: string[] = [];
const readTools = (store: ReviewRunStore) =>
  Object.fromEntries(buildReviewReadToolContracts(store).map((tool) => [tool.name, tool]));

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function state(): ReviewState {
  const root = mkdtempSync(join(tmpdir(), "pi-pr-review-root-"));
  temps.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "const value = 1;\nneedle\n");
  const artifact = mkdtempSync(join(tmpdir(), "pi-pr-review-art-"));
  temps.push(artifact);
  const diffPath = join(artifact, "diff.patch");
  const diff =
    "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n same\n+needle\n";
  writeFileSync(diffPath, diff);
  return {
    snapshot: {
      id: "r",
      artifactDir: artifact,
      worktree: root,
      diffPath,
      diffHash: sha256(diff),
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
  it("reads regular hash-matching pinned evidence and rejects tampering or non-files", () => {
    const s = state();
    expect(readVerifiedPinnedDiff(s.snapshot)).toContain("+needle");

    writeFileSync(s.snapshot.diffPath, "tampered");
    expect(() => readVerifiedPinnedDiff(s.snapshot)).toThrow(/integrity/);

    rmSync(s.snapshot.diffPath);
    mkdirSync(s.snapshot.diffPath);
    expect(() => readVerifiedPinnedDiff(s.snapshot)).toThrow(/regular file/);
  });
  it("rejects pinned evidence outside the current ingestion budget", () => {
    const s = state();
    // File metadata exercises admission without constructing an oversized payload.
    // This preserves the existing guard, not a claim that 8 MB is the right budget.
    truncateSync(s.snapshot.diffPath, 8_000_001);
    expect(() => readVerifiedPinnedDiff(s.snapshot)).toThrow(/exceeds/);
  });

  it("uses fixed-string grep, exact diff path matching, and complete source reads", async () => {
    let s = state();
    const saved: ReviewState[] = [];
    const tools = readTools({
      get state() {
        return s;
      },
      set state(v) {
        s = v;
      },
      save: (v) => saved.push(v),
    });
    expect(
      (
        (await tools.review_grep.execute(
          { pattern: "[not-regex", path: "src" } as any,
          { cwd: s.snapshot.worktree },
        )) as any
      ).content[0].text,
    ).toContain("No matches");
    writeFileSync(join(s.snapshot.worktree, "src", "literal.txt"), "literal [not-regex\n");
    const literalMatch = await tools.review_grep.execute(
      { pattern: "[not-regex", path: "src" } as any,
      { cwd: s.snapshot.worktree },
    ) as any;
    expect(literalMatch.content[0].text).toBe("src/literal.txt:1:literal [not-regex");
    const read = await tools.review_read.execute(
      { path: "src/a.ts" } as any,
      { cwd: s.snapshot.worktree },
    ) as any;
    expect(read.content[0].text).toBe("const value = 1;\nneedle\n");
    expect(
      (
        (await tools.review_diff.execute(
          { path: "a.ts" } as any,
          { cwd: s.snapshot.worktree },
        )) as any
      ).content[0].text,
    ).toContain("No diff for path.");
    expect(
      (
        (await tools.review_diff.execute(
          { path: "src/a.ts" } as any,
          { cwd: s.snapshot.worktree },
        )) as any
      ).content[0].text,
    ).toContain("diff --git");
    const ambiguousDiff =
      "diff --git a/dir b/part/a.ts b/dir b/part/a.ts\n--- a/dir b/part/a.ts\n+++ b/dir b/part/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    writeFileSync(s.snapshot.diffPath, ambiguousDiff);
    s.snapshot.diffHash = sha256(ambiguousDiff);
    const ambiguousTools = readTools({ state: s, save: () => {} });
    const ambiguous = await ambiguousTools.review_diff.execute(
      { path: "dir b/part/a.ts" } as any,
      { cwd: s.snapshot.worktree },
    ) as any;
    expect(JSON.parse(ambiguous.content[0].text).text).toBe(ambiguousDiff);
  });

  it("pages pinned metadata and diff sections, and reads a selected source range", async () => {
    const s = state();
    s.snapshot.metadata.body = "start-🙂🙂-end";
    const latePath = join(s.snapshot.worktree, "src", "late.ts");
    writeFileSync(
      latePath,
      "line-1\nline-2\nline-3",
    );
    const lateDiff = [
      "diff --git a/src/late.ts b/src/late.ts",
      "--- a/src/late.ts",
      "+++ b/src/late.ts",
      "@@ -1,1 +1,3 @@",
      "+line-1",
      "+line-2",
      "+line-3",
    ].join("\n");
    writeFileSync(s.snapshot.diffPath, lateDiff);
    s.snapshot.diffHash = sha256(lateDiff);
    const tools = readTools({ state: s, save: () => {} });
    let metadataBody = "";
    let metadataOffset = 0;
    const metadataParts = ["start-", "🙂🙂", "-end"];
    for (const [index, expected] of metadataParts.entries()) {
      const response = await tools.review_metadata.execute(
        { offset: metadataOffset, maxBytes: 8 },
        { cwd: s.snapshot.worktree },
      ) as any;
      const page = JSON.parse(response.content[0].text);
      expect(page.title).toBe("Pinned title");
      expect(page.bodyOffset).toBe(metadataOffset);
      expect(page.body).toBe(expected);
      metadataBody += page.body;
      metadataOffset = Buffer.byteLength(metadataBody);
      expect(page.nextOffset).toBe(index < metadataParts.length - 1 ? metadataOffset : undefined);
    }
    expect(metadataBody).toBe(s.snapshot.metadata.body);
    const source = (await tools.review_read.execute(
      { path: "src/late.ts", startLine: 2, endLine: 3 },
      { cwd: s.snapshot.worktree },
    )) as any;
    expect(source.content[0].text).toBe("line-2\nline-3");
    const diffFirst = (await tools.review_diff.execute(
      { path: "src/late.ts", maxBytes: 100 },
      { cwd: s.snapshot.worktree },
    )) as any;
    const diffSecond = (await tools.review_diff.execute(
      { path: "src/late.ts", offset: diffFirst.details.nextOffset, maxBytes: 100 },
      { cwd: s.snapshot.worktree },
    )) as any;
    expect(diffFirst.details.hunks).toEqual([
      { startLine: 4, endLine: 7, header: "@@ -1,1 +1,3 @@" },
    ]);
    const firstPage = JSON.parse(diffFirst.content[0].text);
    const secondPage = JSON.parse(diffSecond.content[0].text);
    expect(firstPage.nextOffset).toBe(Buffer.byteLength(firstPage.text));
    expect(secondPage.offset).toBe(firstPage.nextOffset);
    expect(secondPage.nextOffset).toBeUndefined();
    expect(firstPage.text + secondPage.text).toBe(lateDiff);
  });

  it("pages the complete changed-file manifest beyond prompt and scan limits", async () => {
    const s = state();
    s.snapshot.metadata.changedFiles = Array.from({ length: 1500 }, (_, index) => ({
      path: `src/${index.toString().padStart(5, "0")}-${"x".repeat(20)}.ts`,
    }));
    const tools = readTools({ state: s, save: () => {} });
    const expectedPaths = s.snapshot.metadata.changedFiles.map((file) => file.path);
    expect(expectedPaths.join("\n").length).toBeGreaterThan(24_000);
    const paths: string[] = [];
    for (const page of [1, 2, 3]) {
      const response = await tools.review_changed_files.execute(
        { page, pageSize: 500 },
        { cwd: s.snapshot.worktree },
      ) as any;
      const result = JSON.parse(response.content[0].text);
      expect(result).toMatchObject({ page, pageSize: 500, total: expectedPaths.length, totalPages: 3 });
      paths.push(...result.items);
    }
    expect(paths).toEqual(expectedPaths);
  });

  it("rejects pre-aborted metadata execution", async () => {
    const s = state();
    const tools = readTools({ state: s, save: () => {} });
    const ac = new AbortController();
    ac.abort();
    await expect(
      tools.review_metadata.execute({}, { cwd: s.snapshot.worktree, signal: ac.signal }),
    ).rejects.toThrow(/cancelled/);
  });
});
