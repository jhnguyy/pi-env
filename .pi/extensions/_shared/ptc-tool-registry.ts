import type { PtcToolEvents, PtcToolRegistration } from "./ptc-tools";

type PtcToolHandler = (registration: PtcToolRegistration) => void;

export interface PtcToolRegistry {
  remember(registration: PtcToolRegistration): PtcToolRegistration | null;
  notify(registration: PtcToolRegistration): void;
  replay(handler: PtcToolHandler): void;
  listen(handler: PtcToolHandler): void;
}

interface PtcToolRegistryState {
  registrations: Map<string, PtcToolRegistration>;
  listeners: Set<PtcToolHandler>;
}

const STORE_KEY = "__piEnvPtcToolRegistry";

function state(): PtcToolRegistryState {
  const root = globalThis as typeof globalThis & { [STORE_KEY]?: PtcToolRegistryState };
  root[STORE_KEY] ??= {
    registrations: new Map<string, PtcToolRegistration>(),
    listeners: new Set<PtcToolHandler>(),
  };
  return root[STORE_KEY];
}

export function getPtcToolRegistry(): PtcToolRegistry {
  return {
    remember(registration) {
      const store = state();
      const previous = store.registrations.get(registration.tool.name);
      if (previous?.tool === registration.tool) return null;
      store.registrations.set(registration.tool.name, registration);
      return registration;
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

export function connectPtcToolEventBus(pi: PtcToolEvents, handler: PtcToolHandler): void {
  pi.events.on?.("ptc-tools:register", (data: unknown) => {
    const registration = data as PtcToolRegistration;
    getPtcToolRegistry().remember(registration);
    handler(registration);
  });
}

export function resetPtcToolRegistryForTests(): void {
  const root = globalThis as typeof globalThis & { [STORE_KEY]?: PtcToolRegistryState };
  delete root[STORE_KEY];
}
