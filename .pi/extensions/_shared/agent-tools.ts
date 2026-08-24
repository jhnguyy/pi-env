import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRememberedRegistrationChannel } from "./remembered-registration-channel";

export const PiEvent = {
  SessionStart: "session_start",
  SessionShutdown: "session_shutdown",
  SessionBeforeTree: "session_before_tree",
  BeforeAgentStart: "before_agent_start",
  BeforeProviderRequest: "before_provider_request",
  TurnEnd: "turn_end",
  Context: "context",
  ToolResult: "tool_result",
  AgentEnd: "agent_end",
} as const;
export type PiEvent = (typeof PiEvent)[keyof typeof PiEvent];

export const AgentToolEvent = {
  Register: "agent-tools:register",
  Unregister: "agent-tools:unregister",
} as const;
export type AgentToolEvent = (typeof AgentToolEvent)[keyof typeof AgentToolEvent];

export const ToolCapability = {
  Read: "read",
  Write: "write",
  Execute: "execute",
} as const;
export type ToolCapability = (typeof ToolCapability)[keyof typeof ToolCapability];

export interface AgentToolFactoryContext {
  readonly cwd: string;
  readonly sessionGeneration: string;
  readonly parentContext?: ExtensionContext;
}

export interface ExtToolRegistration {
  tool: AgentTool<any, any>;
  capabilities: ToolCapability[];
  audience?: "public" | "dag";
  createTool?: (context: AgentToolFactoryContext) => AgentTool<any, any>;
  sessionGeneration?: string;
}

interface AgentToolEventBus {
  emit(event: AgentToolEvent, data: ExtToolRegistration): void;
  on?(event: AgentToolEvent, handler: (data: unknown) => void): void | (() => void);
}

export interface AgentToolEvents {
  events: AgentToolEventBus;
  on(event: typeof PiEvent.SessionStart, handler: (...args: any[]) => void): void;
}

type AgentToolHandler = (registration: ExtToolRegistration) => void;

const agentToolChannel = createRememberedRegistrationChannel<ExtToolRegistration, AgentToolEvent>({
  storeKey: "__piEnvAgentToolRegistry",
  legacyStoreKey: "__piEnvAgentToolStore",
  registerEvent: AgentToolEvent.Register,
  unregisterEvent: AgentToolEvent.Unregister,
  keyOf: (registration) => registration.tool.name,
  isDuplicate: (previous, next) => previous === next,
});

function withFactory(
  registration: ExtToolRegistration,
  sessionGeneration?: string,
): ExtToolRegistration {
  const generation = registration.sessionGeneration ?? sessionGeneration;
  return {
    ...registration,
    sessionGeneration: generation,
    createTool:
      registration.createTool ?? (() => ({ ...registration.tool }) as AgentTool<any, any>),
  };
}

export function formatCapabilities(caps: ToolCapability[]): string {
  return caps.join(", ");
}

export function registerAgentTools(
  pi: AgentToolEvents,
  registrations: ExtToolRegistration | ExtToolRegistration[],
  sessionGeneration?: string,
): ExtToolRegistration[] {
  const active = (Array.isArray(registrations) ? registrations : [registrations]).map(
    (registration) => withFactory(registration, sessionGeneration),
  );
  for (const registration of active) agentToolChannel.publish(pi.events, registration);
  return active;
}

export function unregisterAgentTools(
  pi: AgentToolEvents,
  registrations: readonly ExtToolRegistration[],
): void {
  for (const registration of registrations) agentToolChannel.unpublish(pi.events, registration);
}

export function registerAgentToolsOnSessionStart(
  pi: AgentToolEvents,
  registrations:
    | ExtToolRegistration
    | ExtToolRegistration[]
    | ((
        sessionGeneration: string,
        ctx: ExtensionContext,
      ) => ExtToolRegistration | ExtToolRegistration[]),
): void {
  let active: ExtToolRegistration[] = [];
  pi.on(PiEvent.SessionStart, (_event, ctx: ExtensionContext) => {
    if (active.length > 0) unregisterAgentTools(pi, active);
    const generation = randomUUID();
    const resolved =
      typeof registrations === "function" ? registrations(generation, ctx) : registrations;
    active = registerAgentTools(pi, resolved, generation);
  });
  (pi.on as (event: string, handler: (...args: any[]) => void) => void)(
    PiEvent.SessionShutdown,
    () => {
      unregisterAgentTools(pi, active);
      active = [];
    },
  );
}

export function listenForAgentTools(
  pi: AgentToolEvents,
  handler: AgentToolHandler,
  removalHandler?: AgentToolHandler,
): () => void {
  return agentToolChannel.subscribe(pi.events, handler, removalHandler);
}

export function resetAgentToolRegistryForTests(): void {
  agentToolChannel.reset();
}
