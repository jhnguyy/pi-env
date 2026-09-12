import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { DocumentManager } from "../document-manager";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function testResolveLanguageId(): string {
  return "typescript";
}

describeIfEnabled("dev-tools", "DocumentManager", () => {
  let tmpDir: string;
  let dm: DocumentManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lsp-dm-"));
    dm = new DocumentManager(testResolveLanguageId, () => tmpDir);
  });

  afterEach(() => {
    dm.clear();
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  });

  function mkFile(name: string, content: string): string {
    const p = join(tmpDir, name);
    writeFileSync(p, content, "utf8");
    return p;
  }

  // ─── ensure ────────────────────────────────────────────────────────────────

  describe("ensure", () => {
    it("opens a new file with its language, version, and content", () => {
      const p = mkFile("a.ts", "export type T = string;");
      const result = dm.ensure(p);

      expect(result.uri).toMatch(/^file:\/\//);
      expect(result.notification).toMatchObject({
        type: "didOpen",
        params: {
          textDocument: { languageId: "typescript", version: 1, text: "export type T = string;" },
        },
      });
    });

    it("does not track or notify for a missing file", () => {
      expect(dm.ensure(join(tmpDir, "missing.ts")).notification).toBeNull();
      expect(dm.openUris).toEqual([]);
      expect(dm.projectRoots).toEqual([]);
    });

    it("does not notify for unchanged content", () => {
      const p = mkFile("a.ts", "export type T = string;");
      dm.ensure(p);

      expect(dm.ensure(p).notification).toBeNull();
    });

    it("sends changed content with a new version", () => {
      const p = mkFile("a.ts", "const x = 1;");
      dm.ensure(p);
      writeFileSync(p, "const x = 2;", "utf8");

      expect(dm.ensure(p).notification).toMatchObject({
        type: "didChange",
        params: {
          textDocument: { version: 2 },
          contentChanges: [{ text: "const x = 2;" }],
        },
      });
    });

    it("identifies only the first file in a project as a new root", () => {
      const first = mkFile("a.ts", "const x = 1;");
      const second = mkFile("b.ts", "const y = 2;");

      expect(dm.ensure(first).isNewRoot).toBe(true);
      expect(dm.ensure(second).isNewRoot).toBe(false);
    });
  });

  // ─── close ──────────────────────────────────────────────────────────────────

  describe("close", () => {
    it("returns uri for an open file and removes it", () => {
      const p = mkFile("a.ts", "const a = 1;");
      dm.ensure(p);
      const uri = dm.close(p);
      expect(uri).not.toBeNull();
      expect(uri).toMatch(/^file:\/\//);
    });

    it("returns null for a file that is not open", () => {
      const result = dm.close("/nonexistent/foo.ts");
      expect(result).toBeNull();
    });

    it("cleans up project files tracking", () => {
      const p = mkFile("a.ts", "const a = 1;");
      dm.ensure(p);
      expect(dm.projectRoots.length).toBe(1);
      dm.close(p);
      // Project root should be removed since no files remain
      expect(dm.projectRoots.length).toBe(0);
    });

    it("preserves other files in the same project", () => {
      const p1 = mkFile("a.ts", "const a = 1;");
      const p2 = mkFile("b.ts", "const b = 2;");
      dm.ensure(p1);
      dm.ensure(p2);
      dm.close(p1);
      // Project root should remain since p2 is still open
      expect(dm.projectRoots.length).toBe(1);
    });

    it("allows re-opening a closed file", () => {
      const p = mkFile("a.ts", "const a = 1;");
      dm.ensure(p);
      dm.close(p);
      const result = dm.ensure(p);
      expect(result.notification).not.toBeNull();
      expect(result.notification!.type).toBe("didOpen");
    });
  });

  // ─── projectRoots / openUris ───────────────────────────────────────────────

  describe("state tracking", () => {
    it("tracks open URIs", () => {
      const p = mkFile("a.ts", "const a = 1;");
      dm.ensure(p);
      expect(dm.openUris.length).toBe(1);
    });

    it("clear() resets state", () => {
      const p = mkFile("a.ts", "const a = 1;");
      dm.ensure(p);
      dm.clear();
      expect(dm.openUris.length).toBe(0);
      expect(dm.projectRoots.length).toBe(0);
    });
  });
});
