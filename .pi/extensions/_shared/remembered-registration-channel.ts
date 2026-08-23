type Handler<T> = (registration: T) => void;
type EventBus<TEvent extends string, TRegistration> = {
  emit(event: TEvent, data: TRegistration): void;
  on?(event: TEvent, handler: (data: unknown) => void): void | (() => void);
};
type ChannelState<T> = {
  registrations: Map<string, T>;
  listeners: Set<Handler<T>>;
  removalListeners: Set<Handler<T>>;
  pendingRemovals: Set<T>;
};

export function createRememberedRegistrationChannel<TRegistration, TEvent extends string>({
  storeKey,
  legacyStoreKey,
  registerEvent,
  unregisterEvent,
  keyOf,
  isDuplicate,
}: {
  storeKey: string;
  legacyStoreKey?: string;
  registerEvent: TEvent;
  unregisterEvent: TEvent;
  keyOf(registration: TRegistration): string;
  isDuplicate(previous: TRegistration | undefined, next: TRegistration): boolean;
}) {
  const root = globalThis as typeof globalThis & Record<string, unknown>;
  const state = (): ChannelState<TRegistration> => {
    root[storeKey] ??= {
      registrations: new Map<string, TRegistration>(),
      listeners: new Set<Handler<TRegistration>>(),
      removalListeners: new Set<Handler<TRegistration>>(),
      pendingRemovals: new Set<TRegistration>(),
    };
    const current = root[storeKey] as Partial<ChannelState<TRegistration>>;
    current.registrations ??= new Map<string, TRegistration>();
    current.listeners ??= new Set<Handler<TRegistration>>();
    current.removalListeners ??= new Set<Handler<TRegistration>>();
    current.pendingRemovals ??= new Set<TRegistration>();
    if (legacyStoreKey) delete root[legacyStoreKey];
    return current as ChannelState<TRegistration>;
  };
  const remember = (registration: TRegistration): boolean => {
    const registrations = state().registrations;
    const key = keyOf(registration);
    if (isDuplicate(registrations.get(key), registration)) return false;
    registrations.set(key, registration);
    return true;
  };
  const forget = (registration: TRegistration): boolean => {
    const registrations = state().registrations;
    const key = keyOf(registration);
    if (registrations.get(key) !== registration) return false;
    registrations.delete(key);
    return true;
  };

  return {
    publish(events: EventBus<TEvent, TRegistration>, registration: TRegistration): void {
      const changed = remember(registration);
      events.emit(registerEvent, registration);
      if (changed && !events.on) {
        for (const listener of state().listeners) listener(registration);
      }
    },
    unpublish(events: EventBus<TEvent, TRegistration>, registration: TRegistration): void {
      if (!forget(registration)) return;
      const store = state();
      store.pendingRemovals.add(registration);
      try {
        events.emit(unregisterEvent, registration);
      } finally {
        store.pendingRemovals.delete(registration);
      }
      if (!events.on) {
        for (const listener of store.removalListeners) listener(registration);
      }
    },
    subscribe(
      events: EventBus<TEvent, TRegistration>,
      handler: Handler<TRegistration>,
      removalHandler?: Handler<TRegistration>,
    ): () => void {
      const store = state();
      let active = true;
      store.listeners.add(handler);
      if (removalHandler) store.removalListeners.add(removalHandler);
      for (const registration of store.registrations.values()) handler(registration);
      const removeRegisterListener = events.on?.(registerEvent, (data) => {
        if (!active) return;
        const registration = data as TRegistration;
        remember(registration);
        handler(registration);
      });
      const removeUnregisterListener = events.on?.(unregisterEvent, (data) => {
        if (!active) return;
        const registration = data as TRegistration;
        const store = state();
        const current = store.registrations.get(keyOf(registration));
        if (current === registration) {
          forget(registration);
          removalHandler?.(registration);
          return;
        }
        if (current === undefined && store.pendingRemovals.has(registration)) {
          removalHandler?.(registration);
        }
      });
      return () => {
        active = false;
        store.listeners.delete(handler);
        if (removalHandler) store.removalListeners.delete(removalHandler);
        if (typeof removeRegisterListener === "function") removeRegisterListener();
        if (typeof removeUnregisterListener === "function") removeUnregisterListener();
      };
    },
    reset(): void {
      delete root[storeKey];
      if (legacyStoreKey) delete root[legacyStoreKey];
    },
  };
}
