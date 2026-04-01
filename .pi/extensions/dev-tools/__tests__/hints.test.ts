/**
 * Tests for backend-configs (isLspSupported) and LspBackend (handles, getLanguageId).
 */

import { describe, expect, it } from "bun:test";
import { isLspSupported } from "../backend-configs";
import { BACKEND_CONFIGS } from "../backend-configs";
import { LspBackend } from "../backend";

// ─── isLspSupported ───────────────────────────────────────────────────────────

describe("isLspSupported", () => {
  it("returns true for .ts files", () => expect(isLspSupported("foo.ts")).toBe(true));
  it("returns true for .tsx files", () => expect(isLspSupported("foo.tsx")).toBe(true));
  it("returns true for .js files", () => expect(isLspSupported("foo.js")).toBe(true));
  it("returns true for .jsx files", () => expect(isLspSupported("foo.jsx")).toBe(true));
  it("returns true for .mts files", () => expect(isLspSupported("foo.mts")).toBe(true));
  it("returns true for .cts files", () => expect(isLspSupported("foo.cts")).toBe(true));
  it("returns true for .mjs files", () => expect(isLspSupported("foo.mjs")).toBe(true));
  it("returns true for .cjs files", () => expect(isLspSupported("foo.cjs")).toBe(true));
  it("returns true for .sh files", () => expect(isLspSupported("foo.sh")).toBe(true));
  it("returns true for .bash files", () => expect(isLspSupported("foo.bash")).toBe(true));
  it("returns true for .zsh files", () => expect(isLspSupported("foo.zsh")).toBe(true));
  it("returns true for .ksh files", () => expect(isLspSupported("foo.ksh")).toBe(true));
  it("returns true for .nix files", () => expect(isLspSupported("foo.nix")).toBe(true));
  it("returns false for .md files", () => expect(isLspSupported("foo.md")).toBe(false));
  it("returns false for .py files", () => expect(isLspSupported("foo.py")).toBe(false));
  it("returns false for files with no extension", () => expect(isLspSupported("Makefile")).toBe(false));
  it("works with absolute paths", () => expect(isLspSupported("/home/user/project/src/index.ts")).toBe(true));
});

// ─── LspBackend handles + getLanguageId ───────────────────────────────────────

describe("LspBackend.handles and getLanguageId (via configs)", () => {
  const backends = BACKEND_CONFIGS.map((c) => new LspBackend(c));
  const getBackend = (path: string) => backends.find((b) => b.handles(path));

  it("typescript backend handles .ts", () => {
    const b = getBackend("foo.ts");
    expect(b?.name).toBe("typescript");
    expect(b?.getLanguageId("foo.ts")).toBe("typescript");
  });
  it("typescript backend returns typescriptreact for .tsx", () => {
    expect(getBackend("foo.tsx")?.getLanguageId("foo.tsx")).toBe("typescriptreact");
  });
  it("typescript backend returns javascript for .js", () => {
    expect(getBackend("foo.js")?.getLanguageId("foo.js")).toBe("javascript");
  });
  it("typescript backend returns javascriptreact for .jsx", () => {
    expect(getBackend("foo.jsx")?.getLanguageId("foo.jsx")).toBe("javascriptreact");
  });
  it("bash backend handles .sh", () => {
    const b = getBackend("foo.sh");
    expect(b?.name).toBe("bash");
    expect(b?.getLanguageId("foo.sh")).toBe("shellscript");
  });
  it("bash backend handles .bash", () => {
    expect(getBackend("foo.bash")?.name).toBe("bash");
  });
  it("nil backend handles .nix", () => {
    const b = getBackend("foo.nix");
    expect(b?.name).toBe("nil");
    expect(b?.getLanguageId("foo.nix")).toBe("nix");
  });
  it("no backend handles .md", () => {
    expect(getBackend("foo.md")).toBeUndefined();
  });
  it("no backend handles .py", () => {
    expect(getBackend("foo.py")).toBeUndefined();
  });
});
