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

interface LinearFailureFields {
  readonly code: LinearErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly recovery?: string;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

export type LinearFailure = Data.TaggedEnum<{
  AuthFailure: LinearFailureFields;
  OAuthFailure: LinearFailureFields;
  ConnectionFailure: LinearFailureFields;
  ValidationFailure: LinearFailureFields;
  TransportFailure: LinearFailureFields;
  StorageFailure: LinearFailureFields;
}>;

export const LinearFailure = Data.taggedEnum<LinearFailure>();

export class LinearExtensionError extends Data.TaggedError(
  "LinearExtensionError",
)<LinearFailureFields> {}

export interface LinearErrorEnvelope {
  error: {
    code: LinearErrorCode;
    message: string;
    retryable: boolean;
    recovery?: string;
    details?: Record<string, unknown>;
  };
}

type LinearErrorOptions = {
  retryable?: boolean;
  recovery?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
};

const FAILURE_TAG_BY_CODE: Record<LinearErrorCode, LinearFailure["_tag"]> = {
  [LinearErrorCode.AuthRequired]: "AuthFailure",
  [LinearErrorCode.SetupRequired]: "AuthFailure",
  [LinearErrorCode.InsufficientScope]: "AuthFailure",
  [LinearErrorCode.WriteConfirmationRequired]: "AuthFailure",
  [LinearErrorCode.OAuthCancelled]: "OAuthFailure",
  [LinearErrorCode.OAuthTimeout]: "OAuthFailure",
  [LinearErrorCode.OAuthInvalidCallback]: "OAuthFailure",
  [LinearErrorCode.OAuthInvalidGrant]: "OAuthFailure",
  [LinearErrorCode.OAuthDenied]: "OAuthFailure",
  [LinearErrorCode.ConnectionAmbiguous]: "ConnectionFailure",
  [LinearErrorCode.ConnectionNotFound]: "ConnectionFailure",
  [LinearErrorCode.AmbiguousReference]: "ConnectionFailure",
  [LinearErrorCode.Conflict]: "ConnectionFailure",
  [LinearErrorCode.Validation]: "ValidationFailure",
  [LinearErrorCode.Forbidden]: "ValidationFailure",
  [LinearErrorCode.NotFound]: "ValidationFailure",
  [LinearErrorCode.Storage]: "StorageFailure",
  [LinearErrorCode.NetworkUnavailable]: "TransportFailure",
  [LinearErrorCode.RateLimited]: "TransportFailure",
  [LinearErrorCode.Api]: "TransportFailure",
};

function errorFields(
  code: LinearErrorCode,
  message: string,
  options: LinearErrorOptions,
): LinearFailureFields {
  return {
    code,
    message,
    retryable: options.retryable ?? false,
    recovery: options.recovery,
    details: options.details,
    cause: options.cause,
  };
}

export function linearFailure(
  code: LinearErrorCode,
  message: string,
  options: LinearErrorOptions = {},
): LinearFailure {
  const fields = errorFields(code, message, options);
  return LinearFailure[FAILURE_TAG_BY_CODE[code]](fields);
}

export function linearError(
  code: LinearErrorCode,
  message: string,
  options: LinearErrorOptions = {},
): LinearExtensionError {
  return new LinearExtensionError(errorFields(code, message, options));
}

function isLinearFailure(error: unknown): error is LinearFailure {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    [
      "AuthFailure",
      "OAuthFailure",
      "ConnectionFailure",
      "ValidationFailure",
      "TransportFailure",
      "StorageFailure",
    ].includes(String(error._tag))
  );
}

export function asLinearError(error: unknown): LinearExtensionError {
  if (error instanceof LinearExtensionError) return error;
  if (isLinearFailure(error)) return new LinearExtensionError(error);
  return linearError(
    LinearErrorCode.Api,
    error instanceof Error ? error.message : "Linear failed.",
    { cause: error },
  );
}

export function errorEnvelope(error: unknown): LinearErrorEnvelope {
  const normalized = asLinearError(error);
  return {
    error: {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      ...(normalized.recovery ? { recovery: normalized.recovery } : {}),
      ...(normalized.details ? { details: normalized.details } : {}),
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
