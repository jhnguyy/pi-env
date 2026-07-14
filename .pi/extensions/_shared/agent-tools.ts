import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createRememberedRegistrationChannel } from "./remembered-registration-channel";

export const PiEvent = {
  SessionStart: "session_start",
  SessionShutdown: "session_shutdown",
  BeforeAgentStart: "before_agent_start",
  BeforeProviderRequest: "before_provider_request",
  TurnEnd: "turn_end",
  Context: "context",
  ToolResult: "tool_result",
  AgentEnd: "agent_end",
} as const;
export type PiEvent = typeof PiEvent[keyof typeof PiEvent];

export const AgentToolEvent = {
  Register: "agent-tools:register",
} as const;
export type AgentToolEvent = typeof AgentToolEvent[keyof typeof AgentToolEvent];

/**
 * Capability tags for extension tool registration.
 *
 * Describes what a tool can do, not what domain it belongs to. Consumers filter
 * by capability to enforce scope boundaries.
 */
export const ToolCapability = {
  Read: "read",
  Write: "write",
  Execute: "execute",
} as const;
export type ToolCapability = typeof ToolCapability[keyof typeof ToolCapability];

/** Payload for the agent-tool registration event consumed by subagent-style tools. */
export interface ExtToolRegistration {
  tool: AgentTool<any, any>;
  capabilities: ToolCapability[];
}

export interface AgentToolEvents {
  events: {
    emit(event: typeof AgentToolEvent.Register, data: ExtToolRegistration): void;
    on?(event: typeof AgentToolEvent.Register, handler: (data: unknown) => void): void;
  };
  on(event: typeof PiEvent.SessionStart, handler: () => void): void;
}

type AgentToolHandler = (registration: ExtToolRegistration) => void;

const agentToolChannel = createRememberedRegistrationChannel<ExtToolRegistration, typeof AgentToolEvent.Register>({
  storeKey: "__piEnvAgentToolRegistry",
  legacyStoreKey: "__piEnvAgentToolStore",
  event: AgentToolEvent.Register,
  isDuplicate: (previous, next) => previous === next,
});

export function formatCapabilities(caps: ToolCapability[]): string {
  return caps.join(", ");
}

export function registerAgentTools(pi: AgentToolEvents, registrations: ExtToolRegistration | ExtToolRegistration[]): void {
  for (const registration of Array.isArray(registrations) ? registrations : [registrations]) {
    agentToolChannel.publish(pi.events, registration);
  }
}

export function registerAgentToolsOnSessionStart(pi: AgentToolEvents, registrations: ExtToolRegistration | ExtToolRegistration[]): void {
  pi.on(PiEvent.SessionStart, () => registerAgentTools(pi, registrations));
}

export function listenForAgentTools(pi: AgentToolEvents, handler: AgentToolHandler): void {
  agentToolChannel.subscribe(pi.events, handler);
}

export function resetAgentToolRegistryForTests(): void {
  agentToolChannel.reset();
}
