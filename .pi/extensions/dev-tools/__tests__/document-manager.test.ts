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

  // ─── open / ensure ─────────────────────────────────────────────────────────

  describe("open", () => {
    it("returns didOpen for a new file", () => {
      const p = mkFile("a.ts", "const x = 1;");
      const result = (dm as any).open(p);
      expect(result).not.toBeNull();
      expect(result!.notification).toBe("didOpen");
      expect(result!.params).toMatchObject({
        textDocument: { languageId: "typescript", version: 1, text: "const x = 1;" },
      });
    });

    it("returns null for unchanged file", () => {
      const p = mkFile("a.ts", "const x = 1;");
      (dm as any).open(p);
      const result2 = (dm as any).open(p);
      expect(result2).toBeNull();
    });

    it("returns didChange after content update", () => {
      const p = mkFile("a.ts", "const x = 1;");
      (dm as any).open(p);
      writeFileSync(p, "const x = 2;", "utf8");
      const result = (dm as any).open(p);
      expect(result).not.toBeNull();
      expect(result!.notification).toBe("didChange");
      expect(result!.params).toMatchObject({
        textDocument: { version: 2 },
        contentChanges: [{ text: "const x = 2;" }],
      });
    });

    it("returns null for non-existent file", () => {
      const result = (dm as any).open("/nonexistent/path/foo.ts");
      expect(result).toBeNull();
    });

    it("marks isNewRoot=true for first file in a project", () => {
      const p = mkFile("a.ts", "const x = 1;");
      const result = (dm as any).open(p);
      expect(result!.isNewRoot).toBe(true);
    });

    it("marks isNewRoot=false for subsequent files in same project", () => {
      const p1 = mkFile("a.ts", "const x = 1;");
      const p2 = mkFile("b.ts", "const y = 2;");
      (dm as any).open(p1);
      const result = (dm as any).open(p2);
      expect(result!.isNewRoot).toBe(false);
    });
  });

  describe("ensure", () => {
    it("returns uri and notification for new file", () => {
      const p = mkFile("a.ts", "export type T = string;");
      const result = dm.ensure(p);
      expect(result.uri).toMatch(/^file:\/\//);
      expect(result.notification).not.toBeNull();
      expect(result.notification!.type).toBe("didOpen");
    });

    it("returns null notification for unchanged file", () => {
      const p = mkFile("a.ts", "export type T = string;");
      dm.ensure(p);
      const result = dm.ensure(p);
      expect(result.notification).toBeNull();
    });
  });

  // ─── close ──────────────────────────────────────────────────────────────────

  describe("close", () => {
    it("returns uri for an open file and removes it", () => {
      const p = mkFile("a.ts", "const a = 1;");
      dm.ensure(p);
      expect(dm.openCount).toBe(1);
      const uri = dm.close(p);
      expect(uri).not.toBeNull();
      expect(uri).toMatch(/^file:\/\//);
      expect(dm.openCount).toBe(0);
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
      expect(dm.openCount).toBe(2);
      dm.close(p1);
      expect(dm.openCount).toBe(1);
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
      expect(dm.openCount).toBe(1);
    });
  });

  // ─── projectRoots / openUris ───────────────────────────────────────────────

  describe("state tracking", () => {
    it("tracks open URIs", () => {
      const p = mkFile("a.ts", "const a = 1;");
      (dm as any).open(p);
      expect(dm.openUris.length).toBe(1);
    });

    it("clear() resets state", () => {
      const p = mkFile("a.ts", "const a = 1;");
      (dm as any).open(p);
      dm.clear();
      expect(dm.openUris.length).toBe(0);
      expect(dm.projectRoots.length).toBe(0);
    });
  });
});
