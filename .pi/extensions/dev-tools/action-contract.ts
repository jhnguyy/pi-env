import type { TSchema } from "typebox";
import { Type } from "typebox";

export const DevToolsAction = {
  Diagnostics: "diagnostics",
  Hover: "hover",
  Definition: "definition",
  Implementation: "implementation",
  References: "references",
  IncomingCalls: "incoming-calls",
  OutgoingCalls: "outgoing-calls",
  Symbols: "symbols",
  Status: "status",
} as const;
export type DevToolsAction = typeof DevToolsAction[keyof typeof DevToolsAction];

export const DevToolsPathMode = {
  None: "none",
  Single: "single",
  Many: "many",
} as const;
export type DevToolsPathMode = typeof DevToolsPathMode[keyof typeof DevToolsPathMode];

export interface DevToolsActionContract {
  readonly pathMode: DevToolsPathMode;
  readonly needsPosition: boolean;
}

export const DEV_TOOLS_ACTION_CONTRACTS = {
  [DevToolsAction.Diagnostics]: { pathMode: DevToolsPathMode.Many, needsPosition: false },
  [DevToolsAction.Hover]: { pathMode: DevToolsPathMode.Single, needsPosition: true },
  [DevToolsAction.Definition]: { pathMode: DevToolsPathMode.Single, needsPosition: true },
  [DevToolsAction.Implementation]: { pathMode: DevToolsPathMode.Single, needsPosition: true },
  [DevToolsAction.References]: { pathMode: DevToolsPathMode.Single, needsPosition: true },
  [DevToolsAction.IncomingCalls]: { pathMode: DevToolsPathMode.Single, needsPosition: true },
  [DevToolsAction.OutgoingCalls]: { pathMode: DevToolsPathMode.Single, needsPosition: true },
  [DevToolsAction.Symbols]: { pathMode: DevToolsPathMode.Single, needsPosition: false },
  [DevToolsAction.Status]: { pathMode: DevToolsPathMode.None, needsPosition: false },
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
