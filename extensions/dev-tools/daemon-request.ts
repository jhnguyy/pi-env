import { Data, Effect } from "effect";
import type { ToolingTelemetryRuntime } from "../../src/telemetry/tooling.js";
import { noopToolingTelemetryRuntime } from "../../src/telemetry/tooling.js";
import { getActionHandler } from "./action-handlers";
import type { FileCache } from "./file-cache";
import type { HandlerBackend, HandlerDeps } from "./handlers";
import { errorResponse, okResponse, type DaemonRequest, type DaemonResponse } from "./protocol";
import {
  DevToolsOperation,
  DevToolsSpanName,
  runWithDevToolsParentSpan,
  withSafeDevToolsSpan,
} from "./telemetry";

class DaemonDispatchFailure extends Data.TaggedError("DaemonDispatchFailure")<{
  readonly cause: unknown;
}> {}

export interface DaemonRequestDeps {
  readonly backends: readonly HandlerBackend[];
  readonly fileCache: FileCache;
  readonly getIdleMs: () => number;
  readonly telemetry?: ToolingTelemetryRuntime;
}

/** Executes parsed requests; the daemon retains transport and resource ownership. */
export function createDaemonRequestExecutor({
  backends,
  fileCache,
  getIdleMs,
  telemetry = noopToolingTelemetryRuntime,
}: DaemonRequestDeps): (req: DaemonRequest) => Promise<DaemonResponse> {
  const deps: HandlerDeps = {
    backends,
    fileCache,
    getIdleMs,
    getBackend: (path) => {
      const backend = backends.find((candidate) => candidate.handles(path));
      if (!backend) throw new Error(`No language server configured for: ${path}`);
      return backend;
    },
    getWorkspaceSymbolBackends: () =>
      backends.filter((backend) => backend.supportsWorkspaceSymbols),
  };

  async function dispatch(req: DaemonRequest): Promise<DaemonResponse> {
    if (req.action === "shutdown") {
      return okResponse(req.id, {
        action: "status",
        state: "initializing",
        running: false,
        backend: { name: "unknown", running: false },
        project: { mode: "unknown" },
        initialization: { state: "initializing" },
        semantic: { available: false },
        projects: [],
        openFiles: [],
        watchedFiles: 0,
        idleMs: 0,
      });
    }
    const handler = getActionHandler(req.action);
    return handler ? handler(req, deps) : errorResponse(req.id, `Unknown action: ${req.action}`);
  }

  return async (req) => {
    try {
      const dispatchWithoutParent = () =>
        Effect.tryPromise({
          try: () => dispatch(req),
          catch: (cause) => new DaemonDispatchFailure({ cause }),
        });
      const execute = Effect.currentSpan.pipe(
        Effect.matchEffect({
          onFailure: dispatchWithoutParent,
          onSuccess: (parent) =>
            Effect.tryPromise({
              try: () => runWithDevToolsParentSpan(parent, () => dispatch(req)),
              catch: (cause) => new DaemonDispatchFailure({ cause }),
            }),
        }),
      );
      return await Effect.runPromise(
        telemetry.provide(
          withSafeDevToolsSpan(
            telemetry.diagnostics,
            DevToolsSpanName.DaemonRequest,
            {
              operation: DevToolsOperation.DaemonRequest,
              action:
                req.action === "shutdown" || getActionHandler(req.action) ? req.action : "unknown",
            },
            execute,
            () => "dispatch",
            (response) =>
              response.ok ? { outcome: "success" } : { outcome: "failure", error_kind: "response" },
          ),
        ),
      );
    } catch (error: unknown) {
      const cause = error instanceof DaemonDispatchFailure ? error.cause : error;
      return errorResponse(req.id, cause instanceof Error ? cause.message : "Unknown error");
    }
  };
}
