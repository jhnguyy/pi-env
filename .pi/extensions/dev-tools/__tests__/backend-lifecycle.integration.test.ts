import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { resolveNodeCommand } from "../../../../src/process/platform";
import { LspBackend } from "../backend";

const fixturePath = fileURLToPath(new URL("./controlled-lsp-fixture.ts", import.meta.url));

function testBackend(countFile: string): LspBackend {
  return new LspBackend({
    mode: "lsp",
    name: "typescript",
    binaryName: "test-language-server",
    binaryArgs: [],
    launchCommand: resolveNodeCommand(),
    launchArgs: [fixturePath, countFile],
    extensions: new Map([[".ts", "typescript"]]),
    rootMarkers: [],
    capabilities: {},
    codePrefix: "TS",
    supportsWorkspaceSymbols: true,
  } as any);
}

describe("LspBackend lifecycle", () => {
  it("receives diagnostics over LSP and normalizes cached public diagnostics by URI", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-dev-tools-diagnostics-"));
    const backend = testBackend(join(root, "starts"));
    const uri = "file:///test.ts";
    try {
      await backend.ensureStarted();
      await backend.lspRequest("fixture/publishDiagnostics", {
        uri,
        diagnostics: [
          {
            range: { start: { line: 4, character: 2 } },
            severity: 1,
            code: 2339,
            message: "Property 'x' does not exist on type 'Y'.",
          },
          {
            range: { start: { line: 7, character: 0 } },
            severity: 2,
            code: 7017,
            message: "Element implicitly has an 'any' type.",
          },
        ],
      });
      expect(backend.getDiagnostics(uri)).toMatchObject([
        { severity: "error", code: "TS2339", line: 5, character: 3 },
        { severity: "warning", code: "TS7017", line: 8, character: 1 },
      ]);
      expect(backend.getDiagnostics("file:///other.ts")).toEqual([]);
    } finally {
      await backend.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("truncates published diagnostic messages at 200 characters", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-dev-tools-diagnostics-"));
    const backend = testBackend(join(root, "starts"));
    const uri = "file:///test.ts";
    try {
      await backend.ensureStarted();
      await backend.lspRequest("fixture/publishDiagnostics", {
        uri,
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 } },
            severity: 1,
            code: 2322,
            message: "A".repeat(250),
          },
        ],
      });
      expect(backend.getDiagnostics(uri)[0].message).toBe("A".repeat(200) + "…");
    } finally {
      await backend.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("coalesces startup, completes concurrent shutdown calls, and restarts with reset semantic state", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-dev-tools-backend-"));
    const countFile = join(root, "starts");
    const backend = testBackend(countFile);

    try {
      await Promise.all([backend.ensureStarted(), backend.ensureStarted()]);
      expect(backend.isRunning).toBe(true);
      expect(readFileSync(countFile, "utf8").trim().split("\n")).toHaveLength(1);
      backend.recordSemanticResult("textDocument/documentSymbol", 1);
      expect(backend.getStatusSnapshot().semanticAvailable).toBe(true);

      await Promise.all([backend.shutdown(), backend.shutdown()]);
      expect(backend.isRunning).toBe(false);
      expect(backend.getStatusSnapshot()).toMatchObject({
        semanticAvailable: false,
      });
      expect(backend.getStatusSnapshot().lastSemanticRequest).toBeUndefined();

      await Promise.all([backend.ensureStarted(), backend.ensureStarted()]);
      expect(backend.isRunning).toBe(true);
      expect(backend.getStatusSnapshot().semanticAvailable).toBe(false);
      expect(readFileSync(countFile, "utf8").trim().split("\n")).toHaveLength(2);
    } finally {
      await backend.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects JSON-RPC errors and records degraded semantic health", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-dev-tools-backend-error-"));
    const backend = testBackend(join(root, "starts"));

    try {
      await backend.ensureStarted();
      await expect(backend.lspRequest("textDocument/hover", {})).rejects.toThrow(
        "typescript LSP request failed (-32601): unsupported hover",
      );
      expect(backend.getStatusSnapshot()).toMatchObject({
        semanticAvailable: false,
        semanticFailure: {
          method: "textDocument/hover",
          detail: "typescript LSP request failed (-32601): unsupported hover",
        },
      });
    } finally {
      await backend.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("immediate shutdown rejects startup without reporting a running backend", async () => {
    const backend = new LspBackend({
      mode: "lsp",
      name: "typescript",
      binaryName: "test-language-server",
      binaryArgs: [],
      launchCommand: resolveNodeCommand(),
      launchArgs: ["-e", "setInterval(() => {}, 1000)"],
      extensions: new Map([[".ts", "typescript"]]),
      rootMarkers: [],
      capabilities: {},
      codePrefix: "TS",
      supportsWorkspaceSymbols: true,
    } as any);

    const startup = backend.ensureStarted();
    const shutdown = backend.shutdown();

    await shutdown;
    await expect(startup).rejects.toThrow("startup cancelled");
    expect(backend.isRunning).toBe(false);
    await backend.shutdown();
  });
});
