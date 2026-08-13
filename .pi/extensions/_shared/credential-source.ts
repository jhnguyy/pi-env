import { Data } from "effect";

export const CredentialSourceRegistryVersion = 1 as const;

export const CredentialErrorCode = {
  SourceUnavailable: "credential_source_unavailable",
  NotConfigured: "credential_not_configured",
  ProviderUnavailable: "credential_provider_unavailable",
  AuthenticationRequired: "credential_authentication_required",
  AccessDenied: "credential_access_denied",
  Timeout: "credential_timeout",
  InvalidValue: "credential_invalid_value",
  ProviderFailed: "credential_provider_failed",
} as const;

export type CredentialErrorCode = (typeof CredentialErrorCode)[keyof typeof CredentialErrorCode];

export type CredentialName = string;

export interface CredentialUseRequest {
  readonly name: CredentialName;
  readonly consumer: string;
}

export interface CredentialSource {
  has(name: CredentialName): boolean;
  use<T>(
    request: CredentialUseRequest,
    consume: (value: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

export class CredentialSourceError extends Data.TaggedError("CredentialSourceError")<{
  readonly code: CredentialErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly name?: CredentialName;
  readonly provider?: string;
  readonly recovery?: string;
}> {}

interface CredentialSourceRegistration {
  readonly version: typeof CredentialSourceRegistryVersion;
  readonly source: CredentialSource;
}

interface CredentialSourceRegistry {
  readonly version: typeof CredentialSourceRegistryVersion;
  registration?: CredentialSourceRegistration;
}

const REGISTRY_KEY = "__piEnvCredentialSourceRegistryV1";

function registry(): CredentialSourceRegistry {
  const root = globalThis as typeof globalThis & Record<string, unknown>;
  const existing = root[REGISTRY_KEY] as Partial<CredentialSourceRegistry> | undefined;
  if (existing?.version === CredentialSourceRegistryVersion) {
    return existing as CredentialSourceRegistry;
  }
  const created: CredentialSourceRegistry = { version: CredentialSourceRegistryVersion };
  root[REGISTRY_KEY] = created;
  return created;
}

export function registerCredentialSource(source: CredentialSource): () => void {
  const registration: CredentialSourceRegistration = {
    version: CredentialSourceRegistryVersion,
    source,
  };
  registry().registration = registration;
  return () => {
    const store = registry();
    if (store.registration === registration) delete store.registration;
  };
}

export function getCredentialSource(): CredentialSource {
  const registration = registry().registration;
  if (registration?.version === CredentialSourceRegistryVersion) return registration.source;
  throw new CredentialSourceError({
    code: CredentialErrorCode.SourceUnavailable,
    message: "The credential source is not available.",
    retryable: true,
    recovery: "Enable the credential-source extension and reload Pi.",
  });
}

export function resetCredentialSourceRegistryForTests(): void {
  const root = globalThis as typeof globalThis & Record<string, unknown>;
  delete root[REGISTRY_KEY];
}
