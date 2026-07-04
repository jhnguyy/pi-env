import type { AgentToolEvents, ExtToolRegistration } from "./agent-tools";

type AgentToolHandler = (registration: ExtToolRegistration) => void;

export interface AgentToolRegistry {
  remember(registration: ExtToolRegistration): ExtToolRegistration | null;
  notify(registration: ExtToolRegistration): void;
  replay(handler: AgentToolHandler): void;
  listen(handler: AgentToolHandler): void;
}

interface AgentToolRegistryState {
  registrations: Map<string, ExtToolRegistration>;
  listeners: Set<AgentToolHandler>;
}

const STORE_KEY = "__piEnvAgentToolRegistry";
const LEGACY_STORE_KEY = "__piEnvAgentToolStore";

function state(): AgentToolRegistryState {
  const root = globalThis as typeof globalThis & {
    [STORE_KEY]?: AgentToolRegistryState;
    [LEGACY_STORE_KEY]?: unknown;
  };
  root[STORE_KEY] ??= {
    registrations: new Map<string, ExtToolRegistration>(),
    listeners: new Set<AgentToolHandler>(),
  };
  delete root[LEGACY_STORE_KEY];
  return root[STORE_KEY];
}

export function getAgentToolRegistry(): AgentToolRegistry {
  return {
    remember(registration) {
      const store = state();
      const previous = store.registrations.get(registration.tool.name);
      store.registrations.set(registration.tool.name, registration);
      return previous === registration ? null : registration;
    },
    notify(registration) {
      for (const listener of state().listeners) listener(registration);
    },
    replay(handler) {
      for (const registration of state().registrations.values()) handler(registration);
    },
    listen(handler) {
      state().listeners.add(handler);
    },
  };
}

export function connectAgentToolEventBus(pi: AgentToolEvents, handler: AgentToolHandler): void {
  pi.events.on?.("agent-tools:register", (data: unknown) => {
    const registration = data as ExtToolRegistration;
    getAgentToolRegistry().remember(registration);
    handler(registration);
  });
}

export function resetAgentToolRegistryForTests(): void {
  const root = globalThis as typeof globalThis & {
    [STORE_KEY]?: AgentToolRegistryState;
    [LEGACY_STORE_KEY]?: unknown;
  };
  delete root[STORE_KEY];
  delete root[LEGACY_STORE_KEY];
}
