import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  LSP_REQUEST_TIMEOUT_MS,
  LSP_SEMANTIC_REQUEST_TIMEOUT_MS,
  LspBackend,
  LspBackendError,
  lspRequestTimeoutMs,
} from "../backend";
import { REQUEST_TIMEOUT_MS as CLIENT_REQUEST_TIMEOUT_MS } from "../client";
import { BackendMode, type LspBackendConfig } from "../backend-configs";

const baseConfig: LspBackendConfig = {
  mode: BackendMode.Lsp,
  name: "typescript",
  binaryName: "typescript-language-server",
  binaryArgs: [],
  launchCommand: "typescript-language-server",
  launchArgs: [],
  extensions: new Map([[".ts", "typescript"]]),
  capabilities: {},
  initializationOptions: undefined,
  codePrefix: "TS",
  rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
  supportsWorkspaceSymbols: true,
};

describe("LSP request timeout policy", () => {
  it("uses a longer bounded wait for cold semantic navigation requests", () => {
    expect(lspRequestTimeoutMs("textDocument/documentSymbol")).toBe(LSP_SEMANTIC_REQUEST_TIMEOUT_MS);
    expect(lspRequestTimeoutMs("textDocument/hover")).toBe(LSP_SEMANTIC_REQUEST_TIMEOUT_MS);
    expect(lspRequestTimeoutMs("textDocument/definition")).toBe(LSP_SEMANTIC_REQUEST_TIMEOUT_MS);
    expect(lspRequestTimeoutMs("textDocument/implementation")).toBe(LSP_SEMANTIC_REQUEST_TIMEOUT_MS);
    expect(lspRequestTimeoutMs("textDocument/references")).toBe(LSP_SEMANTIC_REQUEST_TIMEOUT_MS);
    expect(lspRequestTimeoutMs("workspace/symbol")).toBe(LSP_SEMANTIC_REQUEST_TIMEOUT_MS);
  });

  it("keeps the existing bounded timeout for unrelated requests", () => {
    expect(lspRequestTimeoutMs("textDocument/rename")).toBe(LSP_REQUEST_TIMEOUT_MS);
  });

  it("keeps the client request timeout longer than the backend semantic timeout", () => {
    expect(CLIENT_REQUEST_TIMEOUT_MS).toBeGreaterThan(LSP_SEMANTIC_REQUEST_TIMEOUT_MS);
  });
});

describe("LSP backend request/root behavior", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("fails backend requests made without a running LSP instead of returning null", async () => {
    const backend = new LspBackend(baseConfig);

    await expect(backend.lspRequest("textDocument/hover", {})).rejects.toBeInstanceOf(LspBackendError);
  });

  it("prefers an ancestor tsconfig/json config root over a nearer package marker", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-lsp-root-"));
    tempDirs.push(root);
    const pkg = join(root, "packages", "leaf");
    mkdirSync(join(pkg, "src"), { recursive: true });
    writeFileSync(join(root, "tsconfig.json"), "{}", "utf8");
    writeFileSync(join(pkg, "package.json"), "{}", "utf8");

    const backend = new LspBackend(baseConfig);

    expect(backend.findProjectRoot(join(pkg, "src", "file.ts"))).toBe(root);
  });
});
