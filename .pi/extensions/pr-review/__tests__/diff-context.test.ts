import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import type { ReviewSnapshot } from "../schema";
import { extractFindingContext, loadPinnedDiff } from "../diff-context";

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function snapshot(diff: string, diffHash = hash(diff)): ReviewSnapshot {
  const root = mkdtempSync(join(tmpdir(), "pi-pr-diff-context-"));
  const artifactDir = join(root, "artifacts");
  mkdirSync(artifactDir);
  const diffPath = join(artifactDir, "diff.patch");
  writeFileSync(diffPath, diff);
  return {
    id: "r1",
    artifactDir,
    worktree: join(root, "worktree"),
    diffPath,
    diffHash,
    createdAt: "2024-01-01T00:00:00.000Z",
    metadata: {
      owner: "acme",
      repo: "widgets",
      number: 1,
      url: "https://github.com/acme/widgets/pull/1",
      baseOid: "b",
      headOid: "h",
      changedFiles: [],
    },
  };
}

function load(diff: string) {
  const result = loadPinnedDiff(snapshot(diff));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

const fixture = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,5 +1,6 @@",
  " one",
  " two",
  "-old",
  "+new",
  " three",
  " four",
  "@@ -20,3 +21,4 @@",
  " alpha",
  "+beta",
  " gamma",
  "diff --git a/old.ts b/new.ts",
  "similarity index 80%",
  "rename from old.ts",
  "rename to new.ts",
  "--- a/old.ts",
  "+++ b/new.ts",
  "@@ -1,2 +1,2 @@",
  " same",
  "+renamed",
  "diff --git a/dead.ts b/dead.ts",
  "deleted file mode 100644",
  "--- a/dead.ts",
  "+++ /dev/null",
  "@@ -3,2 +0,0 @@",
  "-dead",
  "-gone",
  'diff --git "a/space\\040old.ts" "b/space\\040new.ts"',
  '--- "a/space\\040old.ts"',
  '+++ "b/space\\040new.ts"',
  "@@ -1,1 +1,1 @@",
  "-x",
  "+y",
  "",
].join("\n");

describe("pinned diff context", () => {
  it("loads only the pinned artifact after verifying its SHA-256", () => {
    const result = loadPinnedDiff(snapshot(fixture));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toContain("diff --git");
      expect(result.value.byPath.get("src/a.ts")?.[0]?.hunks).toHaveLength(2);
    }
  });

  it("fails closed for unreadable artifacts and hash mismatches", () => {
    expect(loadPinnedDiff({ ...snapshot(fixture), diffPath: join(tmpdir(), "missing.patch") })).toMatchObject({
      ok: false,
      error: { kind: "unreadable_artifact" },
    });
    expect(loadPinnedDiff(snapshot(fixture, "bad"))).toMatchObject({
      ok: false,
      error: { kind: "hash_mismatch" },
    });
  });

  it("extracts RIGHT, LEFT, and context-line anchors from exactly one hunk", () => {
    const diff = load(fixture);
    expect(extractFindingContext(diff, { file: "src/a.ts", side: "RIGHT", line: 3 }, { contextLines: 1 })).toEqual({
      ok: true,
      value: "@@ -1,5 +1,6 @@\n-old\n+new\n three",
    });
    expect(extractFindingContext(diff, { file: "src/a.ts", side: "LEFT", line: 3 }, { contextLines: 0 })).toEqual({
      ok: true,
      value: "@@ -1,5 +1,6 @@\n-old",
    });
    expect(extractFindingContext(diff, { file: "src/a.ts", side: "RIGHT", line: 5 }, { contextLines: 0 })).toEqual({
      ok: true,
      value: "@@ -1,5 +1,6 @@\n four",
    });
  });

  it("indexes multiple hunks without falling back to the full file diff", () => {
    const result = extractFindingContext(load(fixture), { file: "src/a.ts", side: "RIGHT", line: 22 }, { contextLines: 1 });
    expect(result).toEqual({ ok: true, value: "@@ -20,3 +21,4 @@\n alpha\n+beta\n gamma" });
  });

  it("resolves rename, deleted-file LEFT, invalid deleted RIGHT, and quoted paths", () => {
    const diff = load(fixture);
    expect(extractFindingContext(diff, { file: "new.ts", side: "RIGHT", line: 2 })).toMatchObject({ ok: true });
    expect(extractFindingContext(diff, { file: "dead.ts", side: "LEFT", line: 3 })).toEqual({
      ok: true,
      value: "@@ -3,2 +0,0 @@\n-dead\n-gone",
    });
    expect(extractFindingContext(diff, { file: "dead.ts", side: "RIGHT", line: 1 })).toMatchObject({
      ok: false,
      error: { kind: "malformed_anchor" },
    });
    expect(extractFindingContext(diff, { file: "space new.ts", side: "RIGHT", line: 1 })).toEqual({
      ok: true,
      value: "@@ -1,1 +1,1 @@\n-x\n+y",
    });
  });

  it("fails closed for missing files and malformed or missing anchors", () => {
    const diff = load(fixture);
    expect(extractFindingContext(diff, { file: "none.ts", side: "RIGHT", line: 1 })).toMatchObject({
      ok: false,
      error: { kind: "missing_file" },
    });
    expect(extractFindingContext(diff, { file: "src/a.ts", line: 1 })).toMatchObject({
      ok: false,
      error: { kind: "malformed_anchor" },
    });
  });

  it("applies deterministic line and UTF-8 byte bounds", () => {
    const many = [
      "diff --git a/big.ts b/big.ts",
      "--- a/big.ts",
      "+++ b/big.ts",
      "@@ -1,40 +1,41 @@",
      ...Array.from({ length: 12 }, (_, i) => ` before ${i}`),
      "+anchor é",
      ...Array.from({ length: 20 }, (_, i) => ` after ${i}`),
      "",
    ].join("\n");
    const diff = load(many);
    const bounded = extractFindingContext(diff, { file: "big.ts", side: "RIGHT", line: 13 });
    expect(bounded.ok).toBe(true);
    if (bounded.ok) {
      expect(bounded.value.split("\n")).toHaveLength(14);
      expect(Buffer.byteLength(bounded.value, "utf8")).toBeLessThanOrEqual(8192);
    }
    expect(extractFindingContext(diff, { file: "big.ts", side: "RIGHT", line: 13 }, { maxLines: 1 })).toMatchObject({
      ok: false,
      error: { kind: "bound_failure" },
    });
    expect(extractFindingContext(diff, { file: "big.ts", side: "RIGHT", line: 13 }, { maxBytes: 10 })).toMatchObject({
      ok: false,
      error: { kind: "bound_failure" },
    });
  });
});
