import { describe, expect, it } from "vitest";
import { createDiffIndex } from "../diff-index";

function section(oldPath: string, newPath: string, body = "-old\n+new"): string {
  return [
    `diff --git a/${oldPath} b/${newPath}`,
    `--- a/${oldPath}`,
    `+++ b/${newPath}`,
    "@@ -1 +1 @@",
    body,
  ].join("\n");
}

describe("canonical diff index", () => {
  it("indexes a modification by its destination path", () => {
    const index = createDiffIndex(section("src/a.ts", "src/a.ts"));
    expect([...index.keys()]).toEqual(["src/a.ts"]);
    expect(index.get("src/a.ts")?.hunks).toEqual([
      { startLine: 4, endLine: 6, header: "@@ -1 +1 @@" },
    ]);
  });

  it("indexes a rename only by its canonical destination", () => {
    const index = createDiffIndex(section("src/old.ts", "src/new.ts"));
    expect(index.has("src/old.ts")).toBe(false);
    expect(index.get("src/new.ts")?.text).toContain("b/src/new.ts");
  });

  it("uses the source path for a deletion", () => {
    const diff = [
      "diff --git a/src/gone.ts b/src/gone.ts",
      "deleted file mode 100644",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
    ].join("\n");
    expect([...createDiffIndex(diff).keys()]).toEqual(["src/gone.ts"]);
  });

  it("decodes quoted paths and preserves unquoted paths containing spaces", () => {
    const quoted = [
      'diff --git "a/src/quoted name.ts" "b/src/quoted name.ts"',
      '--- "a/src/quoted name.ts"',
      '+++ "b/src/quoted name.ts"',
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const spaced = section("dir with space/a.ts", "dir with space/a.ts");
    const index = createDiffIndex(`${quoted}\n${spaced}`);
    expect([...index.keys()]).toEqual(["src/quoted name.ts", "dir with space/a.ts"]);
  });

  it("falls back to the diff header when patch paths are absent", () => {
    const diff = [
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 100%",
      "rename from src/old.ts",
      "rename to src/new.ts",
    ].join("\n");
    expect([...createDiffIndex(diff).keys()]).toEqual(["src/new.ts"]);
  });

  it("concatenates repeated sections with exact hunk offsets", () => {
    const first = section("src/a.ts", "src/a.ts");
    const middle = section("src/b.ts", "src/b.ts");
    const repeated = section("src/a.ts", "src/a.ts", "-older\n+newer");
    const entry = createDiffIndex(`${first}\n${middle}\n${repeated}`).get("src/a.ts");
    expect(entry?.text).toBe(`${first}\n${repeated}`);
    expect(entry?.hunks).toEqual([
      { startLine: 4, endLine: 6, header: "@@ -1 +1 @@" },
      { startLine: 10, endLine: 12, header: "@@ -1 +1 @@" },
    ]);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry?.hunks)).toBe(true);
  });
});
