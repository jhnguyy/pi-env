import type { ProcessFailure } from "../../../src/process/platform.js";
import {
  CredentialErrorCode,
  CredentialSourceError,
  type CredentialErrorCode as CredentialErrorCodeValue,
  type CredentialName,
} from "../_shared/credential-source";

export interface CredentialErrorOptions {
  readonly name?: CredentialName;
  readonly provider?: string;
  readonly retryable?: boolean;
  readonly recovery?: string;
}

export function credentialError(
  code: CredentialErrorCodeValue,
  message: string,
  options: CredentialErrorOptions = {},
): CredentialSourceError {
  return new CredentialSourceError({
    code,
    message,
    retryable: false,
    ...options,
  });
}

export function providerFailure(error: ProcessFailure, provider: string): CredentialSourceError {
  switch (error.kind) {
    case "timeout":
      return credentialError(
        CredentialErrorCode.Timeout,
        `The ${provider} credential request timed out.`,
        { provider, retryable: true },
      );
    case "spawn":
      return credentialError(
        CredentialErrorCode.ProviderUnavailable,
        `The ${provider} credential provider is not available.`,
        {
          provider,
          recovery: `Install and configure the ${provider} credential provider.`,
        },
      );
    case "interrupted":
      return credentialError(
        CredentialErrorCode.ProviderFailed,
        `The ${provider} credential request was interrupted.`,
        { provider, retryable: true },
      );
    case "output-limit":
      return credentialError(
        CredentialErrorCode.InvalidValue,
        `The ${provider} credential provider returned too much data.`,
        { provider },
      );
    case "exit":
      return credentialError(
        CredentialErrorCode.ProviderFailed,
        `The ${provider} credential provider failed.`,
        { provider, retryable: true },
      );
  }
}

export function sanitizeProviderError(error: unknown, provider: string): CredentialSourceError {
  if (error instanceof CredentialSourceError) return error;
  return credentialError(
    CredentialErrorCode.ProviderFailed,
    `The ${provider} credential provider failed.`,
    { provider, retryable: true },
  );
}
