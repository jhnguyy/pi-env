import { Result } from "effect";
import type { DaemonRequest } from "./protocol";
import { DevToolsAction, DevToolsPathMode, getActionContract } from "./action-contract";
export { DevToolsAction, DEV_TOOLS_ACTIONS } from "./action-contract";

export interface DevToolsParams {
  action: DevToolsAction;
  path?: string | string[];
  line?: number;
  character?: number;
  query?: string;
}

type ClientRequest = Omit<DaemonRequest, "id">;

export interface RequestBuildError {
  readonly _tag: "RequestBuildError";
  readonly message: string;
}

function requestBuildError(message: string): RequestBuildError {
  return { _tag: "RequestBuildError", message };
}

function normalizePathsForAction(params: DevToolsParams): Result.Result<string[], RequestBuildError> {
  const rawPath = params.path;
  const paths = rawPath === undefined ? [] : Array.isArray(rawPath) ? rawPath : [rawPath];
  const mode = getActionContract(params.action).pathMode;

  if (mode === DevToolsPathMode.Single && paths.length > 1) {
    return Result.fail(requestBuildError(`${params.action} requires a single path — ${paths.length} were provided`));
  }

  return Result.succeed(mode === DevToolsPathMode.None ? [] : paths);
}

/**
 * Shared request builder — normalises tool params → daemon wire format.
 * Pure function, no closure dependencies.
 */
export function buildClientRequestResult(params: DevToolsParams): Result.Result<ClientRequest, RequestBuildError> {
  const pathsResult = normalizePathsForAction(params);
  if (Result.isFailure(pathsResult)) return Result.fail(pathsResult.failure);

  const paths = pathsResult.success;
  switch (params.action) {
    case DevToolsAction.Diagnostics:
      return Result.succeed({ action: params.action, paths });
    case DevToolsAction.Status:
      return Result.succeed({ action: params.action });
    case DevToolsAction.Symbols:
      return Result.succeed({ action: params.action, path: paths[0], query: params.query });
    case DevToolsAction.Hover:
    case DevToolsAction.Definition:
    case DevToolsAction.Implementation:
    case DevToolsAction.References:
    case DevToolsAction.IncomingCalls:
    case DevToolsAction.OutgoingCalls:
      return Result.succeed({ action: params.action, path: paths[0], line: params.line, character: params.character });
  }
}

export function buildClientRequest(params: DevToolsParams): ClientRequest {
  const result = buildClientRequestResult(params);
  if (Result.isFailure(result)) throw new Error(result.failure.message);
  return result.success;
}
