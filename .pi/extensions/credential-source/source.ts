import { Effect, Redacted } from "effect";
import {
  CredentialErrorCode,
  type CredentialSource,
  type CredentialSourceError,
  type CredentialUseRequest,
} from "../_shared/credential-source";
import { credentialError } from "./errors";
import type { CredentialEntry } from "./config";
import { guardProviderResolve, type CredentialProvider } from "./providers";

const CREDENTIAL_NAME_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][A-Za-z0-9-]*)+$/;
const CONSUMER_PATTERN = /^[a-z][a-z0-9-]*$/;

export class CredentialSourceRuntime implements CredentialSource {
  readonly #entries: Readonly<Record<string, CredentialEntry>>;
  readonly #providers: ReadonlyMap<CredentialEntry["provider"], CredentialProvider>;

  constructor(
    entries: Readonly<Record<string, CredentialEntry>>,
    providers: ReadonlyMap<CredentialEntry["provider"], CredentialProvider>,
  ) {
    this.#entries = { ...entries };
    this.#providers = providers;
  }

  has(name: string): boolean {
    return CREDENTIAL_NAME_PATTERN.test(name) && Object.hasOwn(this.#entries, name);
  }

  async use<T>(
    request: CredentialUseRequest,
    consume: (value: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const secret = await Effect.runPromise(
      this.#resolveEffect(request),
      signal ? { signal } : undefined,
    );
    try {
      return await consume(Redacted.value(secret));
    } finally {
      Redacted.wipeUnsafe(secret);
    }
  }

  #resolveEffect(
    request: CredentialUseRequest,
  ): Effect.Effect<Redacted.Redacted<string>, CredentialSourceError> {
    if (!CREDENTIAL_NAME_PATTERN.test(request.name) || !CONSUMER_PATTERN.test(request.consumer)) {
      return Effect.fail(
        credentialError(
          CredentialErrorCode.NotConfigured,
          "The requested credential name or consumer is invalid.",
          { name: request.name },
        ),
      );
    }
    const entry = this.#entries[request.name];
    if (!entry) {
      return Effect.fail(
        credentialError(
          CredentialErrorCode.NotConfigured,
          `Credential ${request.name} is not configured.`,
          { name: request.name },
        ),
      );
    }
    if (!entry.consumers.includes(request.consumer)) {
      return Effect.fail(
        credentialError(
          CredentialErrorCode.AccessDenied,
          `Consumer ${request.consumer} cannot use credential ${request.name}.`,
          { name: request.name, provider: entry.provider },
        ),
      );
    }
    const provider = this.#providers.get(entry.provider);
    if (!provider) {
      return Effect.fail(
        credentialError(
          CredentialErrorCode.ProviderUnavailable,
          `The ${entry.provider} credential provider is not available.`,
          { name: request.name, provider: entry.provider },
        ),
      );
    }
    return guardProviderResolve(provider, entry, request.name);
  }
}
