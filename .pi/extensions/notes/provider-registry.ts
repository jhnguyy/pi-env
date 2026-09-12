import { NotesProviderError, type NotesProvider } from "./domain";

const REGISTRY_KEY = Symbol.for("@pi-env/notes-providers");

type Registry = Map<string, NotesProvider>;
type RegistryGlobal = typeof globalThis & { [key: symbol]: unknown };

function registry(): Registry {
  const root = globalThis as RegistryGlobal;
  const existing = root[REGISTRY_KEY];
  if (existing instanceof Map) return existing as Registry;
  const created: Registry = new Map();
  root[REGISTRY_KEY] = created;
  return created;
}

/** Register one provider process-wide so separate extension bundles can supply it. */
export function registerNotesProvider(provider: NotesProvider): () => void {
  validateProvider(provider);
  const providers = registry();
  if (providers.has(provider.id)) {
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

function validateProvider(provider: unknown): asserts provider is NotesProvider {
  if (typeof provider !== "object" || provider === null) {
    throw new NotesProviderError({
      code: "invalid-provider",
      message: "Notes provider does not implement the baseline interface.",
    });
  }
  const candidate = provider as Record<string, unknown>;
  const methods = ["index", "list", "read", "search", "write", "delete"] as const;
  if (
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    methods.some((method) => typeof candidate[method] !== "function") ||
    (candidate.resolve !== undefined && typeof candidate.resolve !== "function")
  ) {
    throw new NotesProviderError({
      code: "invalid-provider",
      message: "Notes provider does not implement the baseline interface.",
    });
  }
}
