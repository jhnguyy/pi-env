import { Data } from "effect";

export const LinearErrorCode = {
  AuthRequired: "auth_required",
  SetupRequired: "setup_required",
  ConnectionAmbiguous: "connection_ambiguous",
  ConnectionNotFound: "connection_not_found",
  InsufficientScope: "insufficient_scope",
  WriteConfirmationRequired: "write_confirmation_required",
  OAuthCancelled: "oauth_cancelled",
  OAuthTimeout: "oauth_timeout",
  OAuthInvalidCallback: "oauth_invalid_callback",
  OAuthInvalidGrant: "oauth_invalid_grant",
  OAuthDenied: "oauth_denied",
  NetworkUnavailable: "network_unavailable",
  RateLimited: "rate_limited",
  Forbidden: "forbidden",
  NotFound: "not_found",
  Validation: "validation_error",
  AmbiguousReference: "ambiguous_reference",
  Conflict: "conflict",
  Storage: "storage_error",
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
