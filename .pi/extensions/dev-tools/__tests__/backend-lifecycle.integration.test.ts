import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";

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
  it("coalesces a real LSP lifetime, recovers semantic health, releases and restarts cleanly", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-dev-tools-backend-"));
    const countFile = join(root, "starts");
    const backend = testBackend(countFile);
    onTestFinished(async () => {
      try {
        await backend.shutdown();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
    const uri = "file:///test.ts";

    await Promise.all([backend.ensureStarted(), backend.ensureStarted()]);
    expect(backend.isRunning).toBe(true);
    const firstPids = readFileSync(countFile, "utf8").trim().split("\n").map(Number);
    expect(firstPids).toHaveLength(1);
    const [firstPid] = firstPids;
    expect(firstPid).toBeGreaterThan(0);
    expect(() => process.kill(firstPid, 0)).not.toThrow();

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
        {
          range: { start: { line: 0, character: 0 } },
          severity: 1,
          code: 2322,
          message: "A".repeat(250),
        },
      ],
    });
    expect(backend.getDiagnostics(uri)).toMatchObject([
      {
        severity: "error",
        code: "TS2339",
        line: 5,
        character: 3,
      },
      {
        severity: "warning",
        code: "TS7017",
        line: 8,
        character: 1,
      },
      {
        severity: "error",
        code: "TS2322",
        line: 1,
        character: 1,
        message: "A".repeat(200) + "…",
      },
    ]);
    expect(backend.getDiagnostics("file:///other.ts")).toEqual([]);

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
    backend.recordSemanticResult("textDocument/documentSymbol", 1);
    expect(backend.getStatusSnapshot()).toMatchObject({
      semanticAvailable: true,
      lastSemanticRequest: { method: "textDocument/documentSymbol", itemCount: 1 },
    });
    expect(backend.getStatusSnapshot().semanticFailure).toBeUndefined();

    await Promise.all([backend.shutdown(), backend.shutdown()]);
    expect(() => process.kill(firstPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    expect(backend.isRunning).toBe(false);
    expect(backend.getStatusSnapshot().semanticAvailable).toBe(false);
    expect(backend.getStatusSnapshot().lastSemanticRequest).toBeUndefined();

    await Promise.all([backend.ensureStarted(), backend.ensureStarted()]);
    expect(backend.isRunning).toBe(true);
    const pids = readFileSync(countFile, "utf8").trim().split("\n").map(Number);
    expect(pids).toHaveLength(2);
    expect(pids[1]).toBeGreaterThan(0);
    expect(pids[1]).not.toBe(firstPid);
    expect(() => process.kill(pids[1], 0)).not.toThrow();
    expect(backend.getStatusSnapshot().semanticAvailable).toBe(false);
    expect(backend.getStatusSnapshot().lastSemanticRequest).toBeUndefined();
    expect(backend.getStatusSnapshot().semanticFailure).toBeUndefined();

    await backend.shutdown();
    for (const pid of pids) {
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
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
    onTestFinished(() => backend.shutdown());

    const startup = expect(backend.ensureStarted()).rejects.toThrow("startup cancelled");
    const shutdown = backend.shutdown();

    await shutdown;
    await startup;
    expect(backend.isRunning).toBe(false);
    await backend.shutdown();
  });
});
