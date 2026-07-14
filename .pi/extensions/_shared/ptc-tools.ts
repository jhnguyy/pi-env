import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createRememberedRegistrationChannel } from "./remembered-registration-channel";

export const PtcToolEvent = {
  Register: "ptc-tools:register",
} as const;
export type PtcToolEvent = typeof PtcToolEvent[keyof typeof PtcToolEvent];

export interface PtcToolRegistration {
  tool: ToolDefinition<any, any, any>;
}

export interface PtcToolEvents {
  events: {
    emit(event: typeof PtcToolEvent.Register, data: PtcToolRegistration): void;
    on?(event: typeof PtcToolEvent.Register, handler: (data: unknown) => void): void;
  };
}

export interface PtcToolRegistrar extends PtcToolEvents {
  registerTool(tool: ToolDefinition<any, any, any>): void;
}

type PtcToolHandler = (registration: PtcToolRegistration) => void;

const ptcToolChannel = createRememberedRegistrationChannel<PtcToolRegistration, typeof PtcToolEvent.Register>({
  storeKey: "__piEnvPtcToolRegistry",
  event: PtcToolEvent.Register,
  isDuplicate: (previous, next) => previous?.tool === next.tool,
});

export function registerPtcTools(
  pi: PtcToolRegistrar,
  tools: ToolDefinition<any, any, any> | ToolDefinition<any, any, any>[],
): void {
  for (const tool of Array.isArray(tools) ? tools : [tools]) {
    pi.registerTool(tool);
    ptcToolChannel.publish(pi.events, { tool });
  }
}

export function listenForPtcTools(pi: PtcToolEvents, handler: PtcToolHandler): void {
  ptcToolChannel.subscribe(pi.events, handler);
}

export function resetPtcToolRegistryForTests(): void {
  ptcToolChannel.reset();
}
