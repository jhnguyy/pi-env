type Handler<T> = (registration: T) => void;
type EventBus<TEvent extends string, TRegistration> = {
  emit(event: TEvent, data: TRegistration): void;
  on?(event: TEvent, handler: (data: unknown) => void): void | (() => void);
};
type ChannelState<T extends object> = {
  registrations: Map<string, T>;
  listeners: Set<Handler<T>>;
  removalListeners: Set<Handler<T>>;
  removedRegistrations: WeakSet<T>;
};

export function createRememberedRegistrationChannel<
  TRegistration extends object,
  TEvent extends string,
>({
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
      removedRegistrations: new WeakSet<TRegistration>(),
    };
    const current = root[storeKey] as Partial<ChannelState<TRegistration>>;
    current.registrations ??= new Map<string, TRegistration>();
    current.listeners ??= new Set<Handler<TRegistration>>();
    current.removalListeners ??= new Set<Handler<TRegistration>>();
    current.removedRegistrations ??= new WeakSet<TRegistration>();
    if (legacyStoreKey) delete root[legacyStoreKey];
    return current as ChannelState<TRegistration>;
  };
  const remember = (registration: TRegistration): boolean => {
    const store = state();
    const key = keyOf(registration);
    if (isDuplicate(store.registrations.get(key), registration)) return false;
    store.registrations.set(key, registration);
    store.removedRegistrations.delete(registration);
    return true;
  };
  const forget = (registration: TRegistration): boolean => {
    const store = state();
    const key = keyOf(registration);
    if (store.registrations.get(key) !== registration) return false;
    store.registrations.delete(key);
    store.removedRegistrations.add(registration);
    return true;
  };

  return {
    publish(events: EventBus<TEvent, TRegistration>, registration: TRegistration): void {
      const store = state();
      const key = keyOf(registration);
      const previous = store.registrations.get(key);
      const changed = remember(registration);
      try {
        events.emit(registerEvent, registration);
      } catch (cause) {
        if (changed && store.registrations.get(key) === registration) {
          forget(registration);
          try {
            events.emit(unregisterEvent, registration);
          } catch {
            // Preserve the original registration failure after rollback notification.
          }
          if (previous !== undefined) {
            store.registrations.set(key, previous);
            store.removedRegistrations.delete(previous);
            try {
              events.emit(registerEvent, previous);
            } catch {
              // Preserve the original registration failure after restoration notification.
            }
          }
        }
        throw cause;
      }
      if (changed && !events.on) {
        for (const listener of store.listeners) listener(registration);
      }
    },
    unpublish(events: EventBus<TEvent, TRegistration>, registration: TRegistration): void {
      if (!forget(registration)) return;
      const store = state();
      events.emit(unregisterEvent, registration);
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
      const seenRemovals = new WeakSet<TRegistration>();
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
        if (current !== undefined && current !== registration) return;
        if (current === registration) forget(registration);
        if (!store.removedRegistrations.has(registration) || seenRemovals.has(registration)) return;
        seenRemovals.add(registration);
        removalHandler?.(registration);
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
