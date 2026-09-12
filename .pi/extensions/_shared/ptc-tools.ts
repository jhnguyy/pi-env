import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { createRememberedRegistrationChannel } from "./remembered-registration-channel";
import { registerPublicTool, type PublicPiToolDefinition } from "./tool-render";

export const PtcToolEvent = {
  Register: "ptc-tools:register",
  Unregister: "ptc-tools:unregister",
} as const;
export type PtcToolEvent = (typeof PtcToolEvent)[keyof typeof PtcToolEvent];

export interface PtcToolRegistration {
  tool: ToolDefinition<any, any, any>;
}

export interface PtcToolEvents {
  events: {
    emit(event: PtcToolEvent, data: PtcToolRegistration): void;
    on?(event: PtcToolEvent, handler: (data: unknown) => void): void;
  };
}

export interface PtcToolRegistrar extends PtcToolEvents {
  registerTool(tool: ToolDefinition<any, any, any>): void;
}

type PtcToolHandler = (registration: PtcToolRegistration) => void;

const ptcToolChannel = createRememberedRegistrationChannel<PtcToolRegistration, PtcToolEvent>({
  storeKey: "__piEnvPtcToolRegistry",
  registerEvent: PtcToolEvent.Register,
  unregisterEvent: PtcToolEvent.Unregister,
  keyOf: (registration) => registration.tool.name,
  isDuplicate: (previous, next) => previous?.tool === next.tool,
});

export function registerPtcTools<Schema extends TSchema, Details = unknown, State = any>(
  pi: PtcToolRegistrar,
  tools:
    | PublicPiToolDefinition<Schema, Details, State>
    | PublicPiToolDefinition<Schema, Details, State>[],
): void {
  for (const tool of Array.isArray(tools) ? tools : [tools]) {
    registerPublicTool(pi, tool);
    ptcToolChannel.publish(pi.events, { tool: tool as ToolDefinition<any, any, any> });
  }
}

export function listenForPtcTools(
  pi: PtcToolEvents,
  handler: PtcToolHandler,
  removalHandler?: PtcToolHandler,
): () => void {
  return ptcToolChannel.subscribe(pi.events, handler, removalHandler);
}
