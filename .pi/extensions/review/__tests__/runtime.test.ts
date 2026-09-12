import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  writeFileSync(join(root, "src", "a.ts"), `${"x".repeat(6000)}\nneedle\n`);
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
  it("admits only bounded, regular, hash-matching pinned evidence", () => {
    const s = state();
    expect(readVerifiedPinnedDiff(s.snapshot)).toContain("+needle");

    writeFileSync(s.snapshot.diffPath, "tampered");
    expect(() => readVerifiedPinnedDiff(s.snapshot)).toThrow(/integrity/);

    writeFileSync(s.snapshot.diffPath, Buffer.alloc(8_000_001));
    expect(() => readVerifiedPinnedDiff(s.snapshot)).toThrow(/exceeds/);

    rmSync(s.snapshot.diffPath);
    mkdirSync(s.snapshot.diffPath);
    expect(() => readVerifiedPinnedDiff(s.snapshot)).toThrow(/regular file/);
  });
  it("uses fixed-string grep, exact diff path matching, and bounded large-line reads", async () => {
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
    expect(
      (
        (await tools.review_read.execute(
          { path: "src/a.ts" } as any,
          { cwd: s.snapshot.worktree },
        )) as any
      ).content[0].text.length,
    ).toBeLessThan(13000);
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
    expect(
      (
        (await ambiguousTools.review_diff.execute(
          { path: "dir b/part/a.ts" } as any,
          { cwd: s.snapshot.worktree },
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
    const lateDiff = [
      "diff --git a/src/late.ts b/src/late.ts",
      "--- a/src/late.ts",
      "+++ b/src/late.ts",
      "@@ -1,1 +1,300 @@",
      ...Array.from({ length: 300 }, (_, index) => `+line-${index + 1}`),
    ].join("\n");
    writeFileSync(s.snapshot.diffPath, lateDiff);
    s.snapshot.diffHash = sha256(lateDiff);
    const tools = readTools({ state: s, save: () => {} });
    const metadataFirst = (await tools.review_metadata.execute(
      { offset: 0, maxBytes: 8 },
      { cwd: s.snapshot.worktree },
    )) as any;
    const metadataFirstBody = JSON.parse(metadataFirst.content[0].text);
    expect(metadataFirstBody.title).toBe("Pinned title");
    expect(metadataFirstBody.body).not.toContain("�");
    expect(metadataFirst.details.nextOffset).toBeTypeOf("number");
    const source = (await tools.review_read.execute(
      { path: "src/late.ts", startLine: 200, endLine: 202 },
      { cwd: s.snapshot.worktree },
    )) as any;
    expect(source.content[0].text).toBe("line-200\nline-201\nline-202");
    const diffFirst = (await tools.review_diff.execute(
      { path: "src/late.ts", maxBytes: 100 },
      { cwd: s.snapshot.worktree },
    )) as any;
    const diffSecond = (await tools.review_diff.execute(
      { path: "src/late.ts", offset: diffFirst.details.nextOffset, maxBytes: 100 },
      { cwd: s.snapshot.worktree },
    )) as any;
    expect(diffFirst.details.hunks).toEqual([
      { startLine: 4, endLine: 304, header: "@@ -1,1 +1,300 @@" },
    ]);
    expect(diffFirst.details.nextOffset).toBeTypeOf("number");
    expect(diffSecond.details.offset).toBe(diffFirst.details.nextOffset);
    expect(diffSecond.content[0].text).not.toBe(diffFirst.content[0].text);
  });

  it("pages the complete changed-file manifest beyond prompt and scan limits", async () => {
    const s = state();
    s.snapshot.metadata.changedFiles = Array.from({ length: 1500 }, (_, index) => ({
      path: `src/${index.toString().padStart(5, "0")}-${"x".repeat(20)}.ts`,
    }));
    const tools = readTools({ state: s, save: () => {} });
    const first = await tools.review_changed_files.execute(
      { page: 1, pageSize: 500 },
      { cwd: s.snapshot.worktree },
    );
    const last = await tools.review_changed_files.execute(
      { page: 3, pageSize: 500 },
      { cwd: s.snapshot.worktree },
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
    const tools = buildReviewReadToolContracts({ state: s, save: () => {} });
    const ac = new AbortController();
    ac.abort();
    await expect(
      tools[0].execute({ path: "src/a.ts" } as any, { cwd: s.snapshot.worktree, signal: ac.signal }),
    ).rejects.toThrow(/cancelled/);
  });
});
