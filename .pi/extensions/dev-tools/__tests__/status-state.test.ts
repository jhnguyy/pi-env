import { describe, expect, it } from "vitest";
import { LspBackend } from "../backend";
import type { LspBackendConfig } from "../backend-configs";
import { handleStatus } from "../handlers";
import type { HandlerDeps } from "../handlers";

const backendConfig: LspBackendConfig = {
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

describe("status state model", () => {
  it("maps an initializing snapshot to initializing status", () => {
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

  it("maps an available snapshot with zero items to ready status", () => {
    expect(status({
      name: "typescript",
      running: true,
      initializationState: "initialized",
      semanticAvailable: true,
      lastSemanticRequest: { method: "textDocument/references", itemCount: 0 },
      projectMode: "configured",
      projectRoot: "/repo",
      tsconfigPath: "/repo/tsconfig.json",
    }, ["/repo"])).toMatchObject({
      state: "ready",
      project: { mode: "configured", root: "/repo", tsconfigPath: "/repo/tsconfig.json" },
      semantic: { available: true, lastRequest: { itemCount: 0 } },
    });
  });

  it("maps a running snapshot with a semantic failure to degraded status", () => {
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

  it("maps an available snapshot with a hover result to ready status", () => {
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

  it("uses an active non-TypeScript backend and prioritizes backend failures", () => {
    const idleTypeScript = {
      name: "typescript",
      running: false,
      initializationState: "initializing",
      semanticAvailable: false,
      projectMode: "unknown",
    };
    const readyBash = {
      name: "bash",
      running: true,
      initializationState: "initialized",
      semanticAvailable: true,
      lastSemanticRequest: { method: "textDocument/documentSymbol", itemCount: 2 },
      projectMode: "inferred",
      projectRoot: "/repo",
    };
    const dependencies = deps(idleTypeScript);
    dependencies.backends.push({
      name: "bash",
      openUris: [],
      projectRoots: ["/repo"],
      getStatusSnapshot: () => readyBash,
    } as any);

    expect(handleStatus({ id: 1, action: "status" }, dependencies).result).toMatchObject({
      state: "ready",
      backend: { name: "bash", running: true },
    });

    readyBash.initializationState = "failed";
    readyBash.semanticAvailable = false;
    expect(handleStatus({ id: 2, action: "status" }, dependencies).result).toMatchObject({
      state: "failed",
      backend: { name: "bash", running: true },
    });
  });

  it("maps a startup-failure snapshot to failed status without semantic failure", () => {
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
