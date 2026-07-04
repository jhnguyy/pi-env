import type { TSchema } from "typebox";
import { Type } from "typebox";

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

export type DevToolsPathMode = "none" | "single" | "many";

export interface DevToolsActionContract {
  readonly pathMode: DevToolsPathMode;
  readonly needsPosition: boolean;
}

export const DEV_TOOLS_ACTION_CONTRACTS = {
  [DevToolsAction.Diagnostics]: { pathMode: "many", needsPosition: false },
  [DevToolsAction.Hover]: { pathMode: "single", needsPosition: true },
  [DevToolsAction.Definition]: { pathMode: "single", needsPosition: true },
  [DevToolsAction.Implementation]: { pathMode: "single", needsPosition: true },
  [DevToolsAction.References]: { pathMode: "single", needsPosition: true },
  [DevToolsAction.IncomingCalls]: { pathMode: "single", needsPosition: true },
  [DevToolsAction.OutgoingCalls]: { pathMode: "single", needsPosition: true },
  [DevToolsAction.Symbols]: { pathMode: "single", needsPosition: false },
  [DevToolsAction.Status]: { pathMode: "none", needsPosition: false },
} as const satisfies Record<DevToolsAction, DevToolsActionContract>;

export const DEV_TOOLS_ACTIONS = Object.values(DevToolsAction);

export const DEV_TOOLS_TOOL_DESCRIPTIONS = {
  action: "Action to perform",
  path:
    "Absolute path to the file. Required for diagnostics, hover, definition, references, and document symbols. " +
    "For diagnostics, pass an array to check all files in one call.",
  line:
    "Line number in the file, 1-indexed. Required for hover, definition, implementation, references, and call hierarchy.",
  character:
    "Column number on the line, 1-indexed. Required for hover, definition, implementation, references, and call hierarchy.",
  query: "Search query for workspace symbols (action=symbols without path).",
} as const;

export function getActionContract(action: DevToolsAction): DevToolsActionContract {
  return DEV_TOOLS_ACTION_CONTRACTS[action];
}

export function createDevToolsParameterSchema<const TAction extends TSchema>(actionEnum: TAction) {
  return Type.Object({
    action: actionEnum,
    path: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], {
      description: DEV_TOOLS_TOOL_DESCRIPTIONS.path,
    })),
    line: Type.Optional(Type.Number({
      minimum: 1,
      description: DEV_TOOLS_TOOL_DESCRIPTIONS.line,
    })),
    character: Type.Optional(Type.Number({
      minimum: 1,
      description: DEV_TOOLS_TOOL_DESCRIPTIONS.character,
    })),
    query: Type.Optional(Type.String({
      description: DEV_TOOLS_TOOL_DESCRIPTIONS.query,
    })),
  });
}
