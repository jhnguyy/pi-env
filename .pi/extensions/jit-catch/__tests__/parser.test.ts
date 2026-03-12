/**
 * Hardening tests for parser.ts
 *
 * Validates: extension extraction, file path cleanup, __tests__ filtering,
 * non-extension file detection, multi-extension diffs, edge cases.
 */

import { describe, it, expect } from "bun:test";
import { parseDiff } from "../parser";

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal unified diff touching the given file paths. */
function diff(...files: string[]): string {
  return files
    .map(
      (f) =>
        `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-old\n+new`,
    )
    .join("\n");
}

// ─── basic extension detection ────────────────────────────────────────────────

describe("parseDiff", () => {
  it("extracts a single extension from a standard git diff path", () => {
    const result = parseDiff(diff(".pi/agent/extensions/tmux/index.ts"));
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].name).toBe("tmux");
    expect(result.extensions[0].changedFiles).toContain(
      ".pi/agent/extensions/tmux/index.ts",
    );
  });

  it("extracts extension name when path has no leading directory", () => {
    const result = parseDiff(diff("extensions/my-extension/client.ts"));
    expect(result.extensions[0].name).toBe("my-extension");
  });

  it("strips the b/ git prefix from file paths", () => {
    const raw = `diff --git a/extensions/tmux/x.ts b/extensions/tmux/x.ts\n--- a/extensions/tmux/x.ts\n+++ b/extensions/tmux/x.ts\n@@ -1 +1 @@\n-a\n+b`;
    const result = parseDiff(raw);
    // changedFile should have b/ stripped
    expect(result.extensions[0].changedFiles[0]).not.toMatch(/^b\//);
    expect(result.extensions[0].changedFiles[0]).toBe("extensions/tmux/x.ts");
  });

  it("deduplicates files within the same extension", () => {
    const d = diff(
      ".pi/agent/extensions/dev-tools/index.ts",
      ".pi/agent/extensions/dev-tools/index.ts",
    );
    expect(result(d).extensions[0].changedFiles).toHaveLength(1);
  });

  // ─── __tests__ filtering ────────────────────────────────────────────────────

  it("ignores __tests__ files — they are not source files", () => {
    const d = diff(
      ".pi/agent/extensions/tmux/index.ts",
      ".pi/agent/extensions/tmux/__tests__/tmux.test.ts",
    );
    const r = parseDiff(d);
    expect(r.extensions[0].changedFiles).toHaveLength(1);
    expect(r.extensions[0].changedFiles[0]).not.toContain("__tests__");
  });

  it("skips an extension entirely if only __tests__ files changed", () => {
    const d = diff(".pi/agent/extensions/tmux/__tests__/tmux.test.ts");
    const r = parseDiff(d);
    expect(r.extensions).toHaveLength(0);
  });

  // ─── non-extension files ─────────────────────────────────────────────────────

  it("flags non-extension files and does not include them in extensions", () => {
    const d = diff(
      ".pi/agent/extensions/tmux/index.ts",
      ".pi/agent/skills/handoff/SKILL.md",
    );
    const r = parseDiff(d);
    expect(r.hasNonExtensionFiles).toBe(true);
    expect(r.extensions).toHaveLength(1);
  });

  it("returns hasNonExtensionFiles=false when all changes are in extensions", () => {
    const r = parseDiff(diff(".pi/agent/extensions/dev-tools/index.ts"));
    expect(r.hasNonExtensionFiles).toBe(false);
  });

  // ─── multi-extension diffs ───────────────────────────────────────────────────

  it("extracts multiple extensions from a single diff", () => {
    const d = diff(
      ".pi/agent/extensions/tmux/index.ts",
      ".pi/agent/extensions/dev-tools/server.ts",
    );
    const r = parseDiff(d);
    const names = r.extensions.map((e) => e.name).sort();
    expect(names).toEqual(["dev-tools", "tmux"]);
  });

  it("groups multiple files within the same extension", () => {
    const d = diff(
      ".pi/agent/extensions/tmux/index.ts",
      ".pi/agent/extensions/tmux/types.ts",
    );
    const r = parseDiff(d);
    expect(r.extensions).toHaveLength(1);
    expect(r.extensions[0].changedFiles).toHaveLength(2);
  });

  // ─── edge cases ──────────────────────────────────────────────────────────────

  it("returns empty result for an empty diff", () => {
    const r = parseDiff("");
    expect(r.extensions).toHaveLength(0);
    expect(r.hasNonExtensionFiles).toBe(false);
  });

  it("ignores /dev/null entries", () => {
    const d = `diff --git a/ext/tmux/old.ts b/ext/tmux/old.ts\n--- a/ext/tmux/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-deleted`;
    const r = parseDiff(d);
    // /dev/null should be ignored entirely
    expect(r.extensions).toHaveLength(0);
  });

  it("filters out node_modules pseudo-extension", () => {
    const d = diff("extensions/node_modules/some-pkg/index.js");
    const r = parseDiff(d);
    expect(r.extensions).toHaveLength(0);
  });
});

// ─── small local helper ───────────────────────────────────────────────────────

function result(diffText: string) {
  return parseDiff(diffText);
}
