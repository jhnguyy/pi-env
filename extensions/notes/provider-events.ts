import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { NotesProvider } from "./domain";
import { registerNotesProvider } from "./provider-registry";

export const NotesProviderEvent = {
  Discover: "notes:provider:discover",
  Register: "notes:provider:register",
} as const;

export interface NotesProviderRegistration {
  readonly provider: NotesProvider;
}

/** Bridge independently bundled providers into the process-wide registry in either load order. */
export function registerNotesProviderEventBridge(pi: ExtensionAPI): () => void {
  const external = new Map<
    string,
    { readonly provider: NotesProvider; readonly unregister: () => void }
  >();

  const stopListening = pi.events.on(NotesProviderEvent.Register, (payload: unknown) => {
    if (!isRegistration(payload)) return;
    const current = external.get(payload.provider.id);
    if (current?.provider === payload.provider) return;
    current?.unregister();
    try {
      const unregister = registerNotesProvider(payload.provider);
      external.set(payload.provider.id, { provider: payload.provider, unregister });
    } catch {
      if (current !== undefined) {
        external.set(current.provider.id, {
          provider: current.provider,
          unregister: registerNotesProvider(current.provider),
        });
      }
    }
  });
  pi.events.emit(NotesProviderEvent.Discover, undefined);

  return () => {
    stopListening();
    for (const registration of external.values()) registration.unregister();
    external.clear();
  };
}

function isRegistration(value: unknown): value is NotesProviderRegistration {
  return (
    typeof value === "object" &&
    value !== null &&
    "provider" in value &&
    typeof value.provider === "object" &&
    value.provider !== null &&
    "id" in value.provider &&
    typeof value.provider.id === "string" &&
    value.provider.id.length > 0
  );
}
