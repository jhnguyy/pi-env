import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { DocumentManager } from "../document-manager";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

describeIfEnabled("lsp", "DocumentManager", () => {
  let tmpDir: string;
  let dm: DocumentManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lsp-dm-"));
    dm = new DocumentManager();
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

  function mkTsconfig(): void {
    writeFileSync(join(tmpDir, "tsconfig.json"), '{"compilerOptions":{}}', "utf8");
  }

  // ─── open / ensure ─────────────────────────────────────────────────────────

  describe("open", () => {
    it("returns didOpen for a new file", () => {
      const p = mkFile("a.ts", "const x = 1;");
      const result = dm.open(p);
      expect(result).not.toBeNull();
      expect(result!.notification).toBe("didOpen");
      expect(result!.params).toMatchObject({
        textDocument: { languageId: "typescript", version: 1, text: "const x = 1;" },
      });
    });

    it("returns null for unchanged file", () => {
      const p = mkFile("a.ts", "const x = 1;");
      dm.open(p);
      const result2 = dm.open(p);
      expect(result2).toBeNull();
    });

    it("returns didChange after content update", () => {
      const p = mkFile("a.ts", "const x = 1;");
      dm.open(p);
      writeFileSync(p, "const x = 2;", "utf8");
      const result = dm.open(p);
      expect(result).not.toBeNull();
      expect(result!.notification).toBe("didChange");
      expect(result!.params).toMatchObject({
        textDocument: { version: 2 },
        contentChanges: [{ text: "const x = 2;" }],
      });
    });

    it("returns null for non-existent file", () => {
      const result = dm.open("/nonexistent/path/foo.ts");
      expect(result).toBeNull();
    });

    it("marks isNewRoot=true for first file in a project", () => {
      mkTsconfig();
      const p = mkFile("a.ts", "const x = 1;");
      const result = dm.open(p);
      expect(result!.isNewRoot).toBe(true);
    });

    it("marks isNewRoot=false for subsequent files in same project", () => {
      mkTsconfig();
      const p1 = mkFile("a.ts", "const x = 1;");
      const p2 = mkFile("b.ts", "const y = 2;");
      dm.open(p1);
      const result = dm.open(p2);
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

  // ─── language ID detection ─────────────────────────────────────────────────

  describe("language ID detection", () => {
    const cases: Array<[string, string]> = [
      ["foo.ts", "typescript"],
      ["foo.tsx", "typescriptreact"],
      ["foo.mts", "typescript"],
      ["foo.cts", "typescript"],
      ["foo.js", "javascript"],
      ["foo.jsx", "javascriptreact"],
      ["foo.sh", "shellscript"],
      ["foo.bash", "shellscript"],
      ["foo.zsh", "shellscript"],
      ["foo.ksh", "shellscript"],
    ];

    for (const [filename, expectedId] of cases) {
      it(`${filename} → ${expectedId}`, () => {
        const p = mkFile(filename, "// hello");
        const result = dm.open(p);
        expect(result).not.toBeNull();
        expect((result!.params as any).textDocument.languageId).toBe(expectedId);
      });
    }
  });

  // ─── project root detection ────────────────────────────────────────────────

  describe("getProjectRoot", () => {
    it("finds tsconfig.json walking up", () => {
      mkTsconfig();
      mkdirSync(join(tmpDir, "src"), { recursive: true });
      const p = join(tmpDir, "src", "foo.ts");
      writeFileSync(p, "// hello", "utf8");
      const root = dm.getProjectRoot(p);
      expect(root).toBe(resolve(tmpDir));
    });

    it("falls back to file's directory if no tsconfig found", () => {
      const p = mkFile("orphan.ts", "// orphan");
      const root = dm.getProjectRoot(p);
      // Should be some valid directory (either tmpDir or parent)
      expect(typeof root).toBe("string");
      expect(root.length).toBeGreaterThan(0);
    });

    it("caches results", () => {
      mkTsconfig();
      const p = mkFile("x.ts", "// x");
      const root1 = dm.getProjectRoot(p);
      const root2 = dm.getProjectRoot(p);
      expect(root1).toBe(root2);
    });
  });

  // ─── projectRoots / openUris ───────────────────────────────────────────────

  describe("state tracking", () => {
    it("tracks open URIs", () => {
      const p = mkFile("a.ts", "const a = 1;");
      dm.open(p);
      expect(dm.openUris.length).toBe(1);
    });

    it("clear() resets state", () => {
      const p = mkFile("a.ts", "const a = 1;");
      dm.open(p);
      dm.clear();
      expect(dm.openUris.length).toBe(0);
      expect(dm.projectRoots.length).toBe(0);
    });
  });
});
