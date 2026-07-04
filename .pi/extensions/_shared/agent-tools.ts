import type { AgentTool } from "@earendil-works/pi-agent-core";

export enum PiEvent {
  SessionStart = "session_start",
}

export enum AgentToolEvent {
  Register = "agent-tools:register",
}

/**
 * Capability tags for extension tool registration.
 *
 * Describes what a tool can do, not what domain it belongs to. Consumers filter
 * by capability to enforce scope boundaries.
 */
export enum ToolCapability {
  Read = "read",
  Write = "write",
  Execute = "execute",
}

/** Payload for the agent-tool registration event consumed by subagent-style tools. */
export interface ExtToolRegistration {
  tool: AgentTool<any, any>;
  capabilities: ToolCapability[];
}

export interface AgentToolEvents {
  events: {
    emit(event: AgentToolEvent.Register, data: ExtToolRegistration): void;
    on?(event: AgentToolEvent.Register, handler: (data: unknown) => void): void;
  };
  on(event: PiEvent.SessionStart, handler: () => void): void;
}

export function formatCapabilities(caps: ToolCapability[]): string {
  return caps.join(", ");
}

export function registerAgentTools(pi: AgentToolEvents, registrations: ExtToolRegistration | ExtToolRegistration[]): void {
  for (const registration of Array.isArray(registrations) ? registrations : [registrations]) {
    pi.events.emit(AgentToolEvent.Register, registration);
  }
}

export function registerAgentToolsOnSessionStart(pi: AgentToolEvents, registrations: ExtToolRegistration | ExtToolRegistration[]): void {
  pi.on(PiEvent.SessionStart, () => registerAgentTools(pi, registrations));
}

export function listenForAgentTools(pi: AgentToolEvents, handler: (registration: ExtToolRegistration) => void): void {
  pi.events.on?.(AgentToolEvent.Register, (data: unknown) => handler(data as ExtToolRegistration));
}
