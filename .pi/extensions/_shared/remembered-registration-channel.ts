type Handler<T> = (registration: T) => void;
type EventBus<TEvent extends string, TRegistration> = {
  emit(event: TEvent, data: TRegistration): void;
  on?(event: TEvent, handler: (data: unknown) => void): void | (() => void);
};
type Bridge = {
  count: number;
  stopRegister?: () => void;
  stopUnregister?: () => void;
};
type ChannelState<T extends object> = {
  registrations: Map<string, T>;
  listeners: Set<Handler<T>>;
  removalListeners: Set<Handler<T>>;
  bridges: WeakMap<object, Bridge>;
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
      bridges: new WeakMap<object, Bridge>(),
    };
    const current = root[storeKey] as Partial<ChannelState<TRegistration>>;
    current.registrations ??= new Map<string, TRegistration>();
    current.listeners ??= new Set<Handler<TRegistration>>();
    current.removalListeners ??= new Set<Handler<TRegistration>>();
    current.bridges ??= new WeakMap<object, Bridge>();
    if (legacyStoreKey) delete root[legacyStoreKey];
    return current as ChannelState<TRegistration>;
  };
  const notify = (handlers: Iterable<Handler<TRegistration>>, registration: TRegistration) => {
    for (const handler of handlers) {
      try {
        handler(registration);
      } catch {
        // One consumer must not prevent lifecycle delivery to other consumers.
      }
    }
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
  const bridge = (events: EventBus<TEvent, TRegistration>): (() => void) => {
    if (!events.on) return () => {};
    const store = state();
    const existing = store.bridges.get(events);
    if (existing) {
      existing.count += 1;
      return () => {
        existing.count -= 1;
        if (existing.count !== 0) return;
        existing.stopRegister?.();
        existing.stopUnregister?.();
        store.bridges.delete(events);
      };
    }
    const active: Bridge = { count: 1 };
    active.stopRegister = events.on(registerEvent, (data) => {
      const registration = data as TRegistration;
      if (remember(registration)) notify(state().listeners, registration);
    }) as (() => void) | undefined;
    active.stopUnregister = events.on(unregisterEvent, (data) => {
      const registration = data as TRegistration;
      if (forget(registration)) notify(state().removalListeners, registration);
    }) as (() => void) | undefined;
    store.bridges.set(events, active);
    return () => {
      active.count -= 1;
      if (active.count !== 0) return;
      active.stopRegister?.();
      active.stopUnregister?.();
      store.bridges.delete(events);
    };
  };

  return {
    publish(events: EventBus<TEvent, TRegistration>, registration: TRegistration): void {
      const store = state();
      const key = keyOf(registration);
      const previous = store.registrations.get(key);
      const changed = remember(registration);
      if (changed) notify(store.listeners, registration);
      try {
        events.emit(registerEvent, registration);
      } catch (cause) {
        if (changed && store.registrations.get(key) === registration) {
          forget(registration);
          notify(store.removalListeners, registration);
          try {
            events.emit(unregisterEvent, registration);
          } catch {
            // Preserve the original registration failure after rollback notification.
          }
          if (previous !== undefined) {
            remember(previous);
            notify(store.listeners, previous);
            try {
              events.emit(registerEvent, previous);
            } catch {
              // Preserve the original registration failure after restoration notification.
            }
          }
        }
        throw cause;
      }
    },
    unpublish(events: EventBus<TEvent, TRegistration>, registration: TRegistration): void {
      if (!forget(registration)) return;
      notify(state().removalListeners, registration);
      events.emit(unregisterEvent, registration);
    },
    subscribe(
      events: EventBus<TEvent, TRegistration>,
      handler: Handler<TRegistration>,
      removalHandler?: Handler<TRegistration>,
    ): () => void {
      const store = state();
      store.listeners.add(handler);
      if (removalHandler) store.removalListeners.add(removalHandler);
      for (const registration of store.registrations.values()) handler(registration);
      const stopBridge = bridge(events);
      return () => {
        store.listeners.delete(handler);
        if (removalHandler) store.removalListeners.delete(removalHandler);
        stopBridge();
      };
    },
    reset(): void {
      delete root[storeKey];
      if (legacyStoreKey) delete root[legacyStoreKey];
    },
  };
}
