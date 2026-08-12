type NamedRegistration = { tool: { name: string } };
type Handler<T> = (registration: T) => void;
type EventBus<TEvent extends string, TRegistration> = {
  emit(event: TEvent, data: TRegistration): void;
  on?(event: TEvent, handler: (data: unknown) => void): void | (() => void);
};
type ChannelState<T> = {
  registrations: Map<string, T>;
  listeners: Set<Handler<T>>;
  removalListeners: Set<Handler<T>>;
};

export function createRememberedRegistrationChannel<
  TRegistration extends NamedRegistration,
  TEvent extends string,
>({
  storeKey,
  legacyStoreKey,
  registerEvent,
  unregisterEvent,
  isDuplicate,
}: {
  storeKey: string;
  legacyStoreKey?: string;
  registerEvent: TEvent;
  unregisterEvent: TEvent;
  isDuplicate(previous: TRegistration | undefined, next: TRegistration): boolean;
}) {
  const root = globalThis as typeof globalThis & Record<string, unknown>;
  const state = (): ChannelState<TRegistration> => {
    root[storeKey] ??= {
      registrations: new Map<string, TRegistration>(),
      listeners: new Set<Handler<TRegistration>>(),
      removalListeners: new Set<Handler<TRegistration>>(),
    };
    const current = root[storeKey] as Partial<ChannelState<TRegistration>>;
    current.registrations ??= new Map<string, TRegistration>();
    current.listeners ??= new Set<Handler<TRegistration>>();
    current.removalListeners ??= new Set<Handler<TRegistration>>();
    if (legacyStoreKey) delete root[legacyStoreKey];
    return current as ChannelState<TRegistration>;
  };
  const remember = (registration: TRegistration): boolean => {
    const registrations = state().registrations;
    if (isDuplicate(registrations.get(registration.tool.name), registration)) return false;
    registrations.set(registration.tool.name, registration);
    return true;
  };
  const forget = (registration: TRegistration): boolean => {
    const registrations = state().registrations;
    if (registrations.get(registration.tool.name) !== registration) return false;
    registrations.delete(registration.tool.name);
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
      events.emit(unregisterEvent, registration);
      if (!events.on) {
        for (const listener of state().removalListeners) listener(registration);
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
        if (active) removalHandler?.(data as TRegistration);
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
