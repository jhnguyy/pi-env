import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocumentManager } from "../document-manager";
import { testTempDirSync } from "../../../../src/testing/temp-dir";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

function testResolveLanguageId(): string {
  return "typescript";
}

describe("DocumentManager", () => {
  let tmpDir: string;
  let dm: DocumentManager;

  beforeEach(() => {
    tmpDir = testTempDirSync("lsp-dm-");
    dm = new DocumentManager(testResolveLanguageId, () => tmpDir);
  });

  afterEach(() => {
    dm.clear();
  });

  function mkFile(name: string, content: string): string {
    const p = join(tmpDir, name);
    writeFileSync(p, content, "utf8");
    return p;
  }

  it("opens, leaves unchanged, changes, closes, and reopens one tracked document", () => {
    const p = mkFile(process.platform === "linux" ? "spaced %20#?.ts" : "a.ts", "const x = 1;");
    const opened = dm.ensure(p);
    const uri = opened.uri;
    if (process.platform === "linux") {
      expect(uri).toBe(`file://${tmpDir}/spaced%20%2520%23%3F.ts`);
    }
    expect(uri).toMatch(/^file:\/\//);
    expect(opened).toEqual({
      uri,
      projectRoot: tmpDir,
      isNewRoot: true,
      notification: {
        type: "didOpen",
        params: {
          textDocument: { uri, languageId: "typescript", version: 1, text: "const x = 1;" },
        },
      },
    });
    expect(dm.openUris).toEqual([uri]);
    expect(dm.projectRoots).toEqual([tmpDir]);
    expect(dm.getDoc(uri)).toMatchObject({
      uri,
      absolutePath: p,
      version: 1,
      content: "const x = 1;",
    });
    expect(dm.ensure(p).notification).toBeNull();

    writeFileSync(p, "const x = 2;", "utf8");
    expect(dm.ensure(p)).toMatchObject({
      uri,
      isNewRoot: false,
      notification: {
        type: "didChange",
        params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: "const x = 2;" }] },
      },
    });
    expect(dm.getDoc(uri)).toMatchObject({ version: 2, content: "const x = 2;" });
    expect(dm.close(p)).toBe(uri);
    expect(dm.getDoc(uri)).toBeUndefined();
    expect(dm.openUris).toEqual([]);
    expect(dm.projectRoots).toEqual([]);

    expect(dm.ensure(p)).toEqual({
      uri,
      projectRoot: tmpDir,
      isNewRoot: true,
      notification: {
        type: "didOpen",
        params: {
          textDocument: { uri, languageId: "typescript", version: 1, text: "const x = 2;" },
        },
      },
    });
    expect(dm.openUris).toEqual([uri]);
  });

  it("does not track or notify for a missing file", () => {
    expect(dm.ensure(join(tmpDir, "missing.ts")).notification).toBeNull();
    expect(dm.openUris).toEqual([]);
    expect(dm.projectRoots).toEqual([]);
  });

  it("identifies only the first file in a project as a new root", () => {
    const first = mkFile("a.ts", "const x = 1;");
    const second = mkFile("b.ts", "const y = 2;");
    expect(dm.ensure(first).isNewRoot).toBe(true);
    expect(dm.ensure(second).isNewRoot).toBe(false);
  });

  it("returns null for a file that is not open", () => {
    expect(dm.close(join(tmpDir, "nonexistent.ts"))).toBeNull();
  });

  it("preserves other files in the same project", () => {
    const p1 = mkFile("a.ts", "const a = 1;");
    const p2 = mkFile("b.ts", "const b = 2;");
    const first = dm.ensure(p1);
    const second = dm.ensure(p2);
    expect(dm.close(p1)).toBe(first.uri);
    expect(dm.openUris).toEqual([second.uri]);
    expect(dm.ensure(p2).notification).toBeNull();
    expect(dm.projectRoots).toEqual([tmpDir]);
  });

  it("clear() resets state", () => {
    dm.ensure(mkFile("a.ts", "const a = 1;"));
    dm.clear();
    expect(dm.openUris).toEqual([]);
    expect(dm.projectRoots).toEqual([]);
  });
});
