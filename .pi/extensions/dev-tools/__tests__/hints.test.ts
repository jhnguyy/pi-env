import { describe, expect, it } from "vitest";

import { LspBackend, findBinary } from "../backend";
import { BACKEND_CONFIGS } from "../backend-configs";

const backends = BACKEND_CONFIGS.map((config) => new LspBackend(config));
const backendFor = (path: string) => backends.find((backend) => backend.handles(path));

describe("advertised language support", () => {
  it.each([
    ["example.ts", "typescript", "typescript"],
    ["example.tsx", "typescript", "typescriptreact"],
    ["example.js", "typescript", "javascript"],
    ["example.jsx", "typescript", "javascriptreact"],
    ["example.mts", "typescript", "typescript"],
    ["example.cts", "typescript", "typescript"],
    ["example.mjs", "typescript", "javascript"],
    ["example.cjs", "typescript", "javascript"],
    ["example.sh", "bash", "shellscript"],
    ["example.bash", "bash", "shellscript"],
    ["example.zsh", "bash", "shellscript"],
    ["example.ksh", "bash", "shellscript"],
    ["example.nix", "nil", "nix"],
  ])("routes %s to %s", (path, backendName, languageId) => {
    const backend = backendFor(path);

    expect(backend?.name).toBe(backendName);
    expect(backend?.getLanguageId(path)).toBe(languageId);
  });

  it("does not route unsupported files", () => {
    expect(backendFor("example.md")).toBeUndefined();
  });
});

describe("findBinary", () => {
  it("finds workspace-installed binaries even when PATH is stripped", async () => {
    const oldPath = process.env["PATH"];
    process.env["PATH"] = "/nonexistent";
    try {
      const bin = await findBinary("typescript-language-server");
      expect(bin).toBeTruthy();
      expect(bin).toContain("node_modules/.bin");
    } finally {
      process.env["PATH"] = oldPath;
    }
  });
});
