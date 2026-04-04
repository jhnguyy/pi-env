/**
 * Tests for backend-configs (isSupported, getBackendConfig) and
 * LspBackend (handles, getLanguageId).
 */

import { describe, expect, it } from "bun:test";
import { isSupported, getBackendConfig, BACKEND_CONFIGS, type LspBackendConfig } from "../backend-configs";
import { LspBackend } from "../backend";

// ─── isSupported ──────────────────────────────────────────────────────────────

describe("isSupported", () => {
  // LSP-backed extensions
  it("returns true for .ts files", () => expect(isSupported("foo.ts")).toBe(true));
  it("returns true for .tsx files", () => expect(isSupported("foo.tsx")).toBe(true));
  it("returns true for .js files", () => expect(isSupported("foo.js")).toBe(true));
  it("returns true for .jsx files", () => expect(isSupported("foo.jsx")).toBe(true));
  it("returns true for .mts files", () => expect(isSupported("foo.mts")).toBe(true));
  it("returns true for .cts files", () => expect(isSupported("foo.cts")).toBe(true));
  it("returns true for .mjs files", () => expect(isSupported("foo.mjs")).toBe(true));
  it("returns true for .cjs files", () => expect(isSupported("foo.cjs")).toBe(true));
  it("returns true for .sh files", () => expect(isSupported("foo.sh")).toBe(true));
  it("returns true for .bash files", () => expect(isSupported("foo.bash")).toBe(true));
  it("returns true for .zsh files", () => expect(isSupported("foo.zsh")).toBe(true));
  it("returns true for .ksh files", () => expect(isSupported("foo.ksh")).toBe(true));
  it("returns true for .nix files", () => expect(isSupported("foo.nix")).toBe(true));
  // Format-backed extensions
  it("returns true for .hcl files", () => expect(isSupported("foo.hcl")).toBe(true));
  it("returns true for .tf files", () => expect(isSupported("foo.tf")).toBe(true));
  it("returns true for .tfvars files", () => expect(isSupported("foo.tfvars")).toBe(true));
  // Unsupported
  it("returns false for .md files", () => expect(isSupported("foo.md")).toBe(false));
  it("returns false for .py files", () => expect(isSupported("foo.py")).toBe(false));
  it("returns false for files with no extension", () => expect(isSupported("Makefile")).toBe(false));
  it("works with absolute paths", () => expect(isSupported("/home/user/project/src/index.ts")).toBe(true));
});

// ─── getBackendConfig ─────────────────────────────────────────────────────────

describe("getBackendConfig", () => {
  it("returns the hcl format backend for .hcl files", () => {
    const c = getBackendConfig("foo.hcl");
    expect(c?.mode).toBe("format");
    expect(c?.name).toBe("hcl");
  });
  it("returns the terraform format backend for .tf files", () => {
    const c = getBackendConfig("foo.tf");
    expect(c?.mode).toBe("format");
    expect(c?.name).toBe("terraform");
  });
  it("returns the terraform format backend for .tfvars files", () => {
    const c = getBackendConfig("foo.tfvars");
    expect(c?.mode).toBe("format");
    expect(c?.name).toBe("terraform");
  });
  it("returns an lsp backend for .ts files", () => {
    const c = getBackendConfig("foo.ts");
    expect(c?.mode).toBe("lsp");
    expect(c?.name).toBe("typescript");
  });
  it("returns null for unsupported extensions", () => {
    expect(getBackendConfig("foo.md")).toBeNull();
  });
  it("hcl formatArgs build the expected terragrunt command", () => {
    const c = getBackendConfig("path/to/main.hcl");
    expect(c?.mode).toBe("format");
    if (c?.mode === "format") {
      expect(c.formatArgs("path/to/main.hcl")).toEqual([
        "hclfmt", "--terragrunt-hclfmt-file", "path/to/main.hcl",
      ]);
    }
  });
  it("tf formatArgs build the expected terraform command", () => {
    const c = getBackendConfig("main.tf");
    expect(c?.mode).toBe("format");
    if (c?.mode === "format") {
      expect(c.formatArgs("main.tf")).toEqual(["fmt", "main.tf"]);
    }
  });
});

// ─── LspBackend handles + getLanguageId ───────────────────────────────────────

describe("LspBackend.handles and getLanguageId (via configs)", () => {
  // LspBackend only consumes LSP-mode configs — mirror the daemon's filter.
  const backends = (BACKEND_CONFIGS.filter((c) => c.mode === "lsp") as LspBackendConfig[])
    .map((c) => new LspBackend(c));
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
  it("no backend handles .hcl (format-only, not LSP)", () => {
    expect(getBackend("foo.hcl")).toBeUndefined();
  });
  it("no backend handles .tf (format-only, not LSP)", () => {
    expect(getBackend("foo.tf")).toBeUndefined();
  });
});
