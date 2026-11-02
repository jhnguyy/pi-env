import { describe, expect, it } from "vitest";
import { LspBackend } from "../backend";
import type { BackendStatusSnapshot } from "../backend";
import { FileCache } from "../file-cache";
import { ControlledBackend } from "./controlled-backend";
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

function backendFor(snapshot: BackendStatusSnapshot, projectRoots: string[] = []) {
  const backend = new ControlledBackend("/repo", snapshot.name, ".ts", projectRoots);
  backend.getStatusSnapshot = () => snapshot;
  return backend;
}

function deps(backends: ControlledBackend[], idleMs = 0): HandlerDeps {
  return {
    getBackend: () => {
      throw new Error("Status must not route a file request");
    },
    getWorkspaceSymbolBackends: () => backends,
    backends,
    fileCache: new FileCache(),
    getIdleMs: () => idleMs,
  };
}

function status(snapshot: BackendStatusSnapshot, projectRoots: string[] = []) {
  return handleStatus({ id: 1, action: "status" }, deps([backendFor(snapshot, projectRoots)]))
    .result;
}

const healthySnapshot: BackendStatusSnapshot = {
  name: "bash",
  running: true,
  initializationState: "initialized",
  semanticAvailable: true,
  lastSemanticRequest: { method: "textDocument/documentSymbol", itemCount: 2 },
  projectMode: "inferred",
  projectRoot: "/scripts",
};

describe("status state model", () => {
  it("maps an initializing snapshot to initializing status", () => {
    expect(
      status({
        name: "typescript",
        running: false,
        initializationState: "initializing",
        semanticAvailable: false,
        projectMode: "unknown",
      }),
    ).toMatchObject({
      state: "initializing",
      backend: { running: false },
      initialization: { state: "initializing" },
      semantic: { available: false },
    });
  });

  it("maps an available snapshot with zero items to ready status", () => {
    expect(
      status(
        {
          name: "typescript",
          running: true,
          initializationState: "initialized",
          semanticAvailable: true,
          lastSemanticRequest: { method: "textDocument/references", itemCount: 0 },
          projectMode: "configured",
          projectRoot: "/repo",
          tsconfigPath: "/repo/tsconfig.json",
        },
        ["/repo"],
      ),
    ).toMatchObject({
      state: "ready",
      project: { mode: "configured", root: "/repo", tsconfigPath: "/repo/tsconfig.json" },
      semantic: { available: true, lastRequest: { itemCount: 0 } },
    });
  });

  it("maps a running snapshot with a semantic failure to degraded status", () => {
    expect(
      status(
        {
          name: "typescript",
          running: true,
          initializationState: "initialized",
          semanticAvailable: false,
          lastSemanticRequest: { method: "textDocument/definition", itemCount: 0 },
          semanticFailure: {
            method: "textDocument/definition",
            detail: "typescript LSP request timed out",
          },
          projectMode: "configured",
          projectRoot: "/repo",
          tsconfigPath: "/repo/tsconfig.json",
        },
        ["/repo"],
      ),
    ).toMatchObject({
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

  it("clears the recorded failure summary when recording a successful empty result", () => {
    const backend = new LspBackend(backendConfig);
    backend.recordSemanticFailure("textDocument/references", `timeout ${"x".repeat(300)}`);

    const failed = backend.getStatusSnapshot();
    expect(failed.semanticFailure?.method).toBe("textDocument/references");
    expect(failed.semanticFailure?.detail).toHaveLength(256);

    backend.recordSemanticResult("textDocument/references", 0);

    const recorded = backend.getStatusSnapshot();
    expect(recorded.semanticFailure).toBeUndefined();
    expect(recorded.lastSemanticRequest).toEqual({
      method: "textDocument/references",
      itemCount: 0,
    });
  });

  it("maps an available snapshot with a hover result to ready status", () => {
    expect(
      status(
        {
          name: "typescript",
          running: true,
          initializationState: "initialized",
          semanticAvailable: true,
          lastSemanticRequest: { method: "textDocument/hover", itemCount: 1 },
          projectMode: "inferred",
          projectRoot: "/repo",
        },
        ["/repo"],
      ),
    ).toMatchObject({
      state: "ready",
      semantic: { available: true, lastRequest: { method: "textDocument/hover", itemCount: 1 } },
    });
  });

  it("uses an active non-TypeScript backend alongside an initializing peer", () => {
    const idleTypeScript: BackendStatusSnapshot = {
      name: "typescript",
      running: false,
      initializationState: "initializing",
      semanticAvailable: false,
      projectMode: "unknown",
    };
    expect(
      handleStatus(
        { id: 1, action: "status" },
        deps([backendFor(idleTypeScript), backendFor(healthySnapshot)]),
      ).result,
    ).toMatchObject({
      state: "ready",
      backend: { name: "bash", running: true },
    });
  });

  describe.each([false, true])("failure priority (healthy peer first: %s)", (healthyFirst) => {
    function withHealthyPeer(snapshot: BackendStatusSnapshot) {
      const backends = [backendFor(snapshot), backendFor(healthySnapshot)];
      if (healthyFirst) backends.reverse();
      return handleStatus({ id: 1, action: "status" }, deps(backends)).result;
    }

    it("does not let a healthy peer conceal a startup failure", () => {
      expect(
        withHealthyPeer({
          name: "typescript",
          running: false,
          initializationState: "failed",
          semanticAvailable: false,
          startupFailure: "typescript LSP initialize timed out",
          projectMode: "unknown",
        }),
      ).toMatchObject({
        state: "failed",
        running: true,
        backend: {
          name: "typescript",
          running: false,
          startupFailure: "typescript LSP initialize timed out",
        },
        initialization: { state: "failed" },
        semantic: { available: false },
      });
    });

    it("does not let a healthy peer conceal a semantic failure or its detail", () => {
      expect(
        withHealthyPeer({
          name: "typescript",
          running: true,
          initializationState: "initialized",
          semanticAvailable: false,
          semanticFailure: {
            method: "textDocument/definition",
            detail: "typescript LSP request timed out",
          },
          projectMode: "configured",
        }),
      ).toMatchObject({
        state: "degraded",
        running: true,
        backend: { name: "typescript", running: true },
        semantic: {
          available: false,
          semanticFailure: {
            method: "textDocument/definition",
            detail: "typescript LSP request timed out",
          },
        },
      });
    });
  });

  it("keeps an initialized running backend initializing until semantics succeed", () => {
    expect(
      status({
        name: "typescript",
        running: true,
        initializationState: "initialized",
        semanticAvailable: false,
        projectMode: "inferred",
      }),
    ).toMatchObject({
      state: "initializing",
      running: true,
      backend: { running: true },
      initialization: { state: "initialized" },
      semantic: { available: false },
    });
  });

  it("reports failed unknown backend health while the daemon is alive with no backends", () => {
    expect(handleStatus({ id: 1, action: "status" }, deps([])).result).toMatchObject({
      state: "failed",
      running: true,
      backend: { name: "unknown", running: false },
      project: { mode: "unknown" },
      initialization: { state: "failed" },
      semantic: { available: false },
      projects: [],
      openFiles: [],
      watchedFiles: 0,
    });
  });

  it("aggregates projects and decoded open file paths across backends and retains idle time", () => {
    const typescript = backendFor({ ...healthySnapshot, name: "typescript" }, ["/repo"]);
    typescript.openUris = ["file:///repo/src/spaced%20file.ts"];
    const bash = backendFor(healthySnapshot, ["/scripts"]);
    bash.openUris = ["file:///scripts/build.sh", "file:///scripts/check.sh"];

    expect(
      handleStatus({ id: 1, action: "status" }, deps([typescript, bash], 12345)).result,
    ).toMatchObject({
      projects: ["/repo", "/scripts"],
      openFiles: ["/repo/src/spaced file.ts", "/scripts/build.sh", "/scripts/check.sh"],
      watchedFiles: 3,
      idleMs: 12345,
    });
  });

  it("maps a startup-failure snapshot to failed status without semantic failure", () => {
    expect(
      status({
        name: "typescript",
        running: false,
        initializationState: "failed",
        semanticAvailable: false,
        startupFailure: "typescript LSP initialize timed out",
        projectMode: "unknown",
      }),
    ).toMatchObject({
      state: "failed",
      running: true,
      backend: { running: false, startupFailure: "typescript LSP initialize timed out" },
      initialization: { state: "failed" },
      semantic: { available: false },
    });
  });
});
