import { Either } from "effect";
import type { DaemonRequest } from "./protocol";

export enum DevToolsAction {
  Diagnostics = "diagnostics",
  Hover = "hover",
  Definition = "definition",
  Implementation = "implementation",
  References = "references",
  IncomingCalls = "incoming-calls",
  OutgoingCalls = "outgoing-calls",
  Symbols = "symbols",
  Status = "status",
}

export const DEV_TOOLS_ACTIONS = Object.values(DevToolsAction);

export interface DevToolsParams {
  action: DevToolsAction;
  path?: string | string[];
  line?: number;
  character?: number;
  query?: string;
}

type PathMode = "none" | "single" | "many";

type ClientRequest = Omit<DaemonRequest, "id">;

export interface RequestBuildError {
  readonly _tag: "RequestBuildError";
  readonly message: string;
}

function requestBuildError(message: string): RequestBuildError {
  return { _tag: "RequestBuildError", message };
}

const PATH_MODE_BY_ACTION: Record<DevToolsAction, PathMode> = {
  [DevToolsAction.Diagnostics]: "many",
  [DevToolsAction.Hover]: "single",
  [DevToolsAction.Definition]: "single",
  [DevToolsAction.Implementation]: "single",
  [DevToolsAction.References]: "single",
  [DevToolsAction.IncomingCalls]: "single",
  [DevToolsAction.OutgoingCalls]: "single",
  [DevToolsAction.Symbols]: "single",
  [DevToolsAction.Status]: "none",
};

function normalizePathsForAction(params: DevToolsParams): Either.Either<string[], RequestBuildError> {
  const rawPath = params.path;
  const paths = rawPath === undefined ? [] : Array.isArray(rawPath) ? rawPath : [rawPath];
  const mode = PATH_MODE_BY_ACTION[params.action];

  if (mode === "single" && paths.length > 1) {
    return Either.left(requestBuildError(`${params.action} requires a single path — ${paths.length} were provided`));
  }

  return Either.right(mode === "none" ? [] : paths);
}

/**
 * Shared request builder — normalises tool params → daemon wire format.
 * Pure function, no closure dependencies.
 */
export function buildClientRequestEither(params: DevToolsParams): Either.Either<ClientRequest, RequestBuildError> {
  const pathsResult = normalizePathsForAction(params);
  if (Either.isLeft(pathsResult)) return Either.left(pathsResult.left);

  const paths = pathsResult.right;
  switch (params.action) {
    case DevToolsAction.Diagnostics:
      return Either.right({ action: params.action, paths });
    case DevToolsAction.Status:
      return Either.right({ action: params.action });
    case DevToolsAction.Symbols:
      return Either.right({ action: params.action, path: paths[0], query: params.query });
    case DevToolsAction.Hover:
    case DevToolsAction.Definition:
    case DevToolsAction.Implementation:
    case DevToolsAction.References:
    case DevToolsAction.IncomingCalls:
    case DevToolsAction.OutgoingCalls:
      return Either.right({ action: params.action, path: paths[0], line: params.line, character: params.character });
  }
}

export function buildClientRequest(params: DevToolsParams): ClientRequest {
  const result = buildClientRequestEither(params);
  if (Either.isLeft(result)) throw new Error(result.left.message);
  return result.right;
}
