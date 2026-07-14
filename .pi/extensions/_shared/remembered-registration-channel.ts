type NamedRegistration = { tool: { name: string } };
type Handler<T> = (registration: T) => void;
type EventBus<TEvent extends string, TRegistration> = {
  emit(event: TEvent, data: TRegistration): void;
  on?(event: TEvent, handler: (data: unknown) => void): void;
};
type ChannelState<T> = {
  registrations: Map<string, T>;
  listeners: Set<Handler<T>>;
};

export function createRememberedRegistrationChannel<
  TRegistration extends NamedRegistration,
  TEvent extends string,
>({
  storeKey,
  legacyStoreKey,
  event,
  isDuplicate,
}: {
  storeKey: string;
  legacyStoreKey?: string;
  event: TEvent;
  isDuplicate(previous: TRegistration | undefined, next: TRegistration): boolean;
}) {
  const root = globalThis as typeof globalThis & Record<string, unknown>;
  const state = (): ChannelState<TRegistration> => {
    root[storeKey] ??= {
      registrations: new Map<string, TRegistration>(),
      listeners: new Set<Handler<TRegistration>>(),
    };
    if (legacyStoreKey) delete root[legacyStoreKey];
    return root[storeKey] as ChannelState<TRegistration>;
  };
  const remember = (registration: TRegistration): boolean => {
    const registrations = state().registrations;
    if (isDuplicate(registrations.get(registration.tool.name), registration)) return false;
    registrations.set(registration.tool.name, registration);
    return true;
  };

  return {
    publish(events: EventBus<TEvent, TRegistration>, registration: TRegistration): void {
      const changed = remember(registration);
      events.emit(event, registration);
      if (changed && !events.on) {
        for (const listener of state().listeners) listener(registration);
      }
    },
    subscribe(events: EventBus<TEvent, TRegistration>, handler: Handler<TRegistration>): void {
      const store = state();
      store.listeners.add(handler);
      for (const registration of store.registrations.values()) handler(registration);
      events.on?.(event, (data) => {
        const registration = data as TRegistration;
        remember(registration);
        handler(registration);
      });
    },
    reset(): void {
      delete root[storeKey];
      if (legacyStoreKey) delete root[legacyStoreKey];
    },
  };
}
