import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { LspBackend } from "../backend";
import { BackendMode, type LspBackendConfig } from "../backend-configs";
import { handleStatus } from "../handlers";
import type { HandlerDeps } from "../handlers";

const backendConfig: LspBackendConfig = {
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
  rootMarkers: ["tsconfig.json"],
  supportsWorkspaceSymbols: true,
};

function deps(snapshot: any, projectRoots: string[] = []): HandlerDeps {
  const backend = {
    name: snapshot.name ?? "typescript",
    openUris: [],
    projectRoots,
    getStatusSnapshot: () => snapshot,
  };
  return {
    getBackend: () => backend as any,
    getWorkspaceSymbolBackends: () => [backend as any],
    backends: [backend as any],
    fileCache: {} as any,
    getIdleMs: () => 0,
  };
}

function status(snapshot: any, projectRoots: string[] = []) {
  return handleStatus({ id: 1, action: "status" }, deps(snapshot, projectRoots)).result;
}

describeIfEnabled("dev-tools", "status state model", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it("transitions idle backend snapshot to initializing before the first semantic result", () => {
    expect(status({
      name: "typescript",
      running: false,
      initializationState: "initializing",
      semanticAvailable: false,
      projectMode: "unknown",
    })).toMatchObject({
      state: "initializing",
      backend: { running: false },
      initialization: { state: "initializing" },
      semantic: { available: false },
    });
  });

  it("transitions successful empty semantic result to ready", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "status-project-"));
    writeFileSync(join(tmpDir, "tsconfig.json"), "{}", "utf8");

    expect(status({
      name: "typescript",
      running: true,
      initializationState: "initialized",
      semanticAvailable: true,
      lastSemanticRequest: { method: "textDocument/references", itemCount: 0 },
      projectMode: "configured",
      projectRoot: tmpDir,
      tsconfigPath: join(tmpDir, "tsconfig.json"),
    }, [tmpDir])).toMatchObject({
      state: "ready",
      project: { mode: "configured", root: tmpDir, tsconfigPath: join(tmpDir, "tsconfig.json") },
      semantic: { available: true, lastRequest: { itemCount: 0 } },
    });
  });

  it("transitions semantic request failure to degraded while the process remains live", () => {
    expect(status({
      name: "typescript",
      running: true,
      initializationState: "initialized",
      semanticAvailable: false,
      lastSemanticRequest: { method: "textDocument/definition", itemCount: 0 },
      semanticFailure: { method: "textDocument/definition", detail: "typescript LSP request timed out" },
      projectMode: "configured",
      projectRoot: "/repo",
      tsconfigPath: "/repo/tsconfig.json",
    }, ["/repo"])).toMatchObject({
      state: "degraded",
      running: true,
      backend: { running: true },
      semantic: {
        available: false,
        lastRequest: { method: "textDocument/definition", itemCount: 0 },
        semanticFailure: { method: "textDocument/definition" },
      },
    });
  });

  it("clears bounded semantic failure detail after a successful empty result", () => {
    const backend = new LspBackend(backendConfig);
    backend.recordSemanticFailure("textDocument/references", `timeout ${"x".repeat(300)}`);

    const failed = backend.getStatusSnapshot();
    expect(failed.semanticFailure?.method).toBe("textDocument/references");
    expect(failed.semanticFailure?.detail).toHaveLength(256);

    backend.recordSemanticResult("textDocument/references", 0);

    const recovered = backend.getStatusSnapshot();
    expect(recovered.semanticFailure).toBeUndefined();
    expect(recovered.lastSemanticRequest).toEqual({
      method: "textDocument/references",
      itemCount: 0,
    });
  });

  it("transitions recovery after a later successful semantic request back to ready", () => {
    expect(status({
      name: "typescript",
      running: true,
      initializationState: "initialized",
      semanticAvailable: true,
      lastSemanticRequest: { method: "textDocument/hover", itemCount: 1 },
      projectMode: "inferred",
      projectRoot: "/repo",
    }, ["/repo"])).toMatchObject({
      state: "ready",
      semantic: { available: true, lastRequest: { method: "textDocument/hover", itemCount: 1 } },
    });
  });

  it("transitions startup failure to failed without using semantic failure", () => {
    expect(status({
      name: "typescript",
      running: false,
      initializationState: "failed",
      semanticAvailable: false,
      startupFailure: "typescript LSP initialize timed out",
      projectMode: "unknown",
    })).toMatchObject({
      state: "failed",
      running: true,
      backend: { running: false, startupFailure: "typescript LSP initialize timed out" },
      initialization: { state: "failed" },
      semantic: { available: false },
    });
  });
});
