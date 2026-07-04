import type { AgentTool } from "@earendil-works/pi-agent-core";

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

interface AgentToolStore {
  registrations: Map<string, ExtToolRegistration>;
  listeners: Set<AgentToolHandler>;
}

const STORE_KEY = "__piEnvAgentToolStore";

function getStore(): AgentToolStore {
  const root = globalThis as typeof globalThis & { [STORE_KEY]?: AgentToolStore };
  root[STORE_KEY] ??= {
    registrations: new Map<string, ExtToolRegistration>(),
    listeners: new Set<AgentToolHandler>(),
  };
  return root[STORE_KEY];
}

function rememberRegistration(registration: ExtToolRegistration): ExtToolRegistration | null {
  const store = getStore();
  const previous = store.registrations.get(registration.tool.name);
  store.registrations.set(registration.tool.name, registration);
  return previous === registration ? null : registration;
}

function notifyListeners(registration: ExtToolRegistration): void {
  for (const listener of getStore().listeners) listener(registration);
}

export function formatCapabilities(caps: ToolCapability[]): string {
  return caps.join(", ");
}

export function registerAgentTools(pi: AgentToolEvents, registrations: ExtToolRegistration | ExtToolRegistration[]): void {
  for (const registration of Array.isArray(registrations) ? registrations : [registrations]) {
    const remembered = rememberRegistration(registration);
    pi.events.emit(AgentToolEvent.Register, registration);
    if (remembered && !pi.events.on) notifyListeners(registration);
  }
}

export function registerAgentToolsOnSessionStart(pi: AgentToolEvents, registrations: ExtToolRegistration | ExtToolRegistration[]): void {
  pi.on(PiEvent.SessionStart, () => registerAgentTools(pi, registrations));
}

export function listenForAgentTools(pi: AgentToolEvents, handler: AgentToolHandler): void {
  const store = getStore();
  store.listeners.add(handler);
  for (const registration of store.registrations.values()) handler(registration);

  pi.events.on?.(AgentToolEvent.Register, (data: unknown) => {
    const registration = data as ExtToolRegistration;
    rememberRegistration(registration);
    handler(registration);
  });
}
