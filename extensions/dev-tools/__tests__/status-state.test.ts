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

describe("status state model", () => {
  it("reports failed unknown health with no backends while the daemon stays alive", () => {
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

  it("selects health through cold, initialized, healthy, semantic-failed, and startup-failed peers", () => {
    const snapshot: BackendStatusSnapshot = {
      name: "typescript",
      running: false,
      initializationState: "initializing",
      semanticAvailable: false,
      projectMode: "unknown",
    };
    const typescript = backendFor(snapshot, ["/repo"]);
    const dependencies = deps([typescript], 12345);
    const request = { id: 1, action: "status" as const };

    expect(handleStatus(request, dependencies).result).toMatchObject({
      state: "initializing",
      running: true,
      backend: { name: "typescript", running: false },
      initialization: { state: "initializing" },
      semantic: { available: false },
    });

    snapshot.running = true;
    snapshot.initializationState = "initialized";
    expect(handleStatus(request, dependencies).result).toMatchObject({
      state: "initializing",
      backend: { running: true },
      initialization: { state: "initialized" },
      semantic: { available: false },
    });

    const healthy = backendFor(
      {
        name: "bash",
        running: true,
        initializationState: "initialized",
        semanticAvailable: true,
        lastSemanticRequest: { method: "textDocument/references", itemCount: 0 },
        projectMode: "inferred",
        projectRoot: "/scripts",
      },
      ["/scripts"],
    );
    typescript.openUris = ["file:///repo/src/spaced%20file.ts"];
    healthy.openUris = ["file:///scripts/build.sh", "file:///scripts/check.sh"];
    for (const backends of [
      [typescript, healthy],
      [healthy, typescript],
    ]) {
      dependencies.backends = backends;
      const result = handleStatus(request, dependencies).result;
      expect(result).toMatchObject({
        state: "ready",
        running: true,
        backend: { name: "bash", running: true },
        initialization: { state: "initialized" },
        project: { mode: "inferred", root: "/scripts" },
        semantic: {
          available: true,
          lastRequest: { method: "textDocument/references", itemCount: 0 },
        },
        watchedFiles: 3,
        idleMs: 12345,
      });
      expect(result).toHaveProperty("projects", expect.arrayContaining(["/repo", "/scripts"]));
      expect(result).toHaveProperty("projects.length", 2);
      expect(result).toHaveProperty("openFiles.length", 3);
      expect(result).toHaveProperty(
        "openFiles",
        expect.arrayContaining([
          "/repo/src/spaced file.ts",
          "/scripts/build.sh",
          "/scripts/check.sh",
        ]),
      );
    }

    snapshot.projectMode = "configured";
    snapshot.projectRoot = "/repo";
    snapshot.tsconfigPath = "/repo/tsconfig.json";
    snapshot.lastSemanticRequest = { method: "textDocument/definition", itemCount: 0 };
    snapshot.semanticFailure = {
      method: "textDocument/definition",
      detail: "typescript LSP request timed out",
    };
    for (const backends of [
      [typescript, healthy],
      [healthy, typescript],
    ]) {
      dependencies.backends = backends;
      expect(handleStatus(request, dependencies).result).toMatchObject({
        state: "degraded",
        running: true,
        backend: { name: "typescript", running: true },
        project: { mode: "configured", root: "/repo", tsconfigPath: "/repo/tsconfig.json" },
        semantic: {
          available: false,
          lastRequest: { method: "textDocument/definition", itemCount: 0 },
          semanticFailure: {
            method: "textDocument/definition",
            detail: "typescript LSP request timed out",
          },
        },
      });
    }

    const startup = backendFor({
      name: "python",
      running: false,
      initializationState: "failed",
      semanticAvailable: false,
      startupFailure: "python LSP initialize timed out",
      projectMode: "unknown",
    });
    for (const backends of [
      [typescript, healthy, startup],
      [startup, healthy, typescript],
    ]) {
      dependencies.backends = backends;
      expect(handleStatus(request, dependencies).result).toMatchObject({
        state: "failed",
        running: true,
        backend: {
          name: "python",
          running: false,
          startupFailure: "python LSP initialize timed out",
        },
        project: { mode: "unknown" },
        initialization: { state: "failed" },
        semantic: { available: false },
      });
    }
  });

  it("records a bounded failure summary then replaces it with a successful empty result", () => {
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
});
