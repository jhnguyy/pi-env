import type { ActionHandler } from "./action-registry";
import type { PublicLspAction } from "./protocol";
import {
  handleDiagnostics,
  handleHover,
  handleDefinition,
  handleImplementation,
  handleReferences,
  handleRename,
  handleIncomingCalls,
  handleOutgoingCalls,
  handleSymbols,
  handleStatus,
} from "./handlers";

/** Routing authority shared by daemon execution and the presentation registry. */
export const actionHandlers = {
  diagnostics: handleDiagnostics,
  hover: handleHover,
  definition: handleDefinition,
  implementation: handleImplementation,
  references: handleReferences,
  rename: handleRename,
  "incoming-calls": handleIncomingCalls,
  "outgoing-calls": handleOutgoingCalls,
  symbols: handleSymbols,
  status: handleStatus,
} satisfies Record<PublicLspAction, ActionHandler>;

export function getActionHandler(action: string): ActionHandler | undefined {
  return Object.hasOwn(actionHandlers, action)
    ? actionHandlers[action as PublicLspAction]
    : undefined;
}
