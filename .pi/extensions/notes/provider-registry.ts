import { NotesProviderError, type NotesProvider } from "./domain";

const REGISTRY_KEY = Symbol.for("@pi-env/notes-providers");

type Registry = Map<string, NotesProvider>;
type RegistryGlobal = typeof globalThis & { [REGISTRY_KEY]?: Registry };

function registry(): Registry {
  const root = globalThis as RegistryGlobal;
  return (root[REGISTRY_KEY] ??= new Map());
}

/** Register one provider process-wide so separate extension bundles can supply it. */
export function registerNotesProvider(provider: NotesProvider): () => void {
  validateProvider(provider);
  const providers = registry();
  const existing = providers.get(provider.id);
  if (existing !== undefined && existing !== provider) {
    throw new NotesProviderError({
      code: "duplicate-provider",
      message: `Notes provider is already registered: ${provider.id}`,
    });
  }
  providers.set(provider.id, provider);
  return () => {
    if (providers.get(provider.id) === provider) providers.delete(provider.id);
  };
}

export function resolveNotesProvider(id: string): NotesProvider {
  const provider = registry().get(id);
  if (provider === undefined) {
    throw new NotesProviderError({
      code: "provider-unavailable",
      message: `Configured notes provider is not registered: ${id}`,
    });
  }
  validateProvider(provider);
  return provider;
}

function validateProvider(provider: NotesProvider): void {
  const candidate = provider as unknown as Record<string, unknown>;
  const methods = ["list", "read", "search", "resolve", "write", "delete"] as const;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    methods.some((method) => typeof candidate[method] !== "function")
  ) {
    throw new NotesProviderError({
      code: "invalid-provider",
      message: "Notes provider does not implement the baseline interface.",
    });
  }
}

export function resetNotesProviderRegistryForTests(): void {
  delete (globalThis as RegistryGlobal)[REGISTRY_KEY];
}
