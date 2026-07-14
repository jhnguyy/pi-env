import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { connectPtcToolEventBus, getPtcToolRegistry } from "./ptc-tool-registry";

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

type PtcToolHandler = (registration: PtcToolRegistration) => void;

export function registerPtcTools(
  pi: PtcToolEvents,
  tools: ToolDefinition<any, any, any> | ToolDefinition<any, any, any>[],
): void {
  for (const tool of Array.isArray(tools) ? tools : [tools]) {
    const registration = { tool };
    const registry = getPtcToolRegistry();
    const remembered = registry.remember(registration);
    pi.events.emit(PtcToolEvent.Register, registration);
    if (remembered && !pi.events.on) registry.notify(registration);
  }
}

export function listenForPtcTools(pi: PtcToolEvents, handler: PtcToolHandler): void {
  const registry = getPtcToolRegistry();
  registry.listen(handler);
  registry.replay(handler);
  connectPtcToolEventBus(pi, handler);
}
