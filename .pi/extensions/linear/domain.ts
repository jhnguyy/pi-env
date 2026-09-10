import { Data } from "effect";
import { CredentialSourceError } from "../_shared/credential-source";

export const LinearErrorCode = {
  AuthRequired: "auth_required",
  NetworkUnavailable: "network_unavailable",
  RateLimited: "rate_limited",
  Forbidden: "forbidden",
  NotFound: "not_found",
  Validation: "validation_error",
  AmbiguousReference: "ambiguous_reference",
  Conflict: "conflict",
  Api: "linear_api_error",
} as const;
export type LinearErrorCode = (typeof LinearErrorCode)[keyof typeof LinearErrorCode];

type LinearErrorFields = {
  readonly code: LinearErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly recovery?: string;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
};

type LinearErrorOptions = Partial<Omit<LinearErrorFields, "code" | "message">>;

export class LinearExtensionError extends Data.TaggedError(
  "LinearExtensionError",
)<LinearErrorFields> {}

export function linearError(
  code: LinearErrorCode,
  message: string,
  options: LinearErrorOptions = {},
): LinearExtensionError {
  return new LinearExtensionError({ code, message, retryable: false, ...options });
}

export function asLinearError(error: unknown): LinearExtensionError {
  if (error instanceof LinearExtensionError) return error;
  if (error instanceof CredentialSourceError) {
    return linearError(LinearErrorCode.AuthRequired, error.message, {
      retryable: error.retryable,
      recovery: error.recovery,
      details: {
        credentialCode: error.code,
        ...(error.name ? { credentialName: error.name } : {}),
        ...(error.provider ? { provider: error.provider } : {}),
      },
    });
  }
  return linearError(
    LinearErrorCode.Api,
    error instanceof Error ? error.message : "Linear failed.",
    { cause: error },
  );
}

export interface LinearErrorEnvelope {
  error: Omit<LinearErrorFields, "cause">;
}

export function errorEnvelope(error: unknown): LinearErrorEnvelope {
  const { code, message, retryable, recovery, details } = asLinearError(error);
  return {
    error: {
      code,
      message,
      retryable,
      ...(recovery ? { recovery } : {}),
      ...(details ? { details } : {}),
    },
  };
}

export class LinearToolError extends Error {
  readonly envelope: LinearErrorEnvelope;

  constructor(error: unknown) {
    const envelope = errorEnvelope(error);
    super(JSON.stringify(envelope));
    this.name = "LinearToolError";
    this.envelope = envelope;
  }
}

export function throwToolError(error: unknown): never {
  throw new LinearToolError(error);
}
