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

function normalizePathsForAction(params: DevToolsParams): string[] {
  const rawPath = params.path;
  const paths = rawPath === undefined ? [] : Array.isArray(rawPath) ? rawPath : [rawPath];
  const mode = PATH_MODE_BY_ACTION[params.action];

  if (mode === "single" && paths.length > 1) {
    throw new Error(`${params.action} requires a single path — ${paths.length} were provided`);
  }

  return mode === "none" ? [] : paths;
}

/**
 * Shared request builder — normalises tool params → daemon wire format.
 * Pure function, no closure dependencies.
 */
export function buildClientRequest(params: DevToolsParams): Omit<DaemonRequest, "id"> {
  const paths = normalizePathsForAction(params);

  switch (params.action) {
    case DevToolsAction.Diagnostics:
      return { action: params.action, paths };
    case DevToolsAction.Status:
      return { action: params.action };
    case DevToolsAction.Symbols:
      return { action: params.action, path: paths[0], query: params.query };
    case DevToolsAction.Hover:
    case DevToolsAction.Definition:
    case DevToolsAction.Implementation:
    case DevToolsAction.References:
    case DevToolsAction.IncomingCalls:
    case DevToolsAction.OutgoingCalls:
      return { action: params.action, path: paths[0], line: params.line, character: params.character };
  }
}
