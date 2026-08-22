import { join } from "node:path";
import { Effect, Redacted } from "effect";
import {
  resolveNodeCommand,
  streamProcess,
  type ProcessFailure,
  type ProcessOutput,
  type StreamProcessOptions,
} from "../../../src/process/platform.js";
import { CredentialErrorCode, type CredentialName } from "../_shared/credential-source";
import type { CredentialEntry } from "./config";
import { credentialError, providerFailure, sanitizeProviderError } from "./errors";

export const CredentialExecutable = {
  OnePassword: "op",
  Bitwarden: "bw",
} as const;

export type CredentialProcessRunner = (
  command: string,
  args: readonly string[],
  options: StreamProcessOptions,
) => Effect.Effect<ProcessOutput, ProcessFailure>;

export interface CredentialProvider {
  readonly id: CredentialEntry["provider"];
  resolve(
    entry: CredentialEntry,
    name: CredentialName,
  ): Effect.Effect<Redacted.Redacted<string>, ReturnType<typeof credentialError>>;
}

export type CredentialExecutableResolver = (
  name: string,
) => string | null | undefined | Promise<string | null | undefined>;

export interface BitwardenSessionSource {
  use<T>(
    consume: (
      session: Redacted.Redacted<string>,
    ) => Effect.Effect<T, ReturnType<typeof credentialError>>,
  ): Effect.Effect<T, ReturnType<typeof credentialError>>;
}

export const DEFAULT_CREDENTIAL_TIMEOUT_MS = 30_000;
export const CREDENTIAL_STDOUT_LIMIT_BYTES = 16 * 1024;
export const CREDENTIAL_STDERR_LIMIT_BYTES = 8 * 1024;

function minimalProviderEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const name of [
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "SYSTEMROOT",
    "TMPDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
  ]) {
    if (env[name] !== undefined) output[name] = env[name];
  }
  return output;
}

const PROVIDER_PROCESS_OPTIONS: StreamProcessOptions = {
  timeoutMs: DEFAULT_CREDENTIAL_TIMEOUT_MS,
  stdoutLimitBytes: CREDENTIAL_STDOUT_LIMIT_BYTES,
  stderrLimitBytes: CREDENTIAL_STDERR_LIMIT_BYTES,
  env: minimalProviderEnvironment(),
};

function validateCredential(
  value: string,
  provider: string,
  name: CredentialName,
): Effect.Effect<Redacted.Redacted<string>, ReturnType<typeof credentialError>> {
  const normalized = value.endsWith("\n") ? value.slice(0, -1) : value;
  if (
    !normalized ||
    normalized.includes("\n") ||
    normalized.includes("\r") ||
    normalized.includes("\0")
  ) {
    return Effect.fail(
      credentialError(
        CredentialErrorCode.InvalidValue,
        `The ${provider} credential provider returned an invalid value.`,
        { provider, name },
      ),
    );
  }
  return Effect.succeed(Redacted.make(normalized, { label: name }));
}

export function createOnePasswordProvider(
  runner: CredentialProcessRunner = streamProcess,
  resolveExecutable: CredentialExecutableResolver = () => CredentialExecutable.OnePassword,
): CredentialProvider {
  return {
    id: "1password",
    resolve(entry, name) {
      if (entry.provider !== "1password") {
        return Effect.fail(
          credentialError(
            CredentialErrorCode.ProviderFailed,
            "The credential entry does not match the 1Password provider.",
            { provider: "1password", name },
          ),
        );
      }
      return Effect.tryPromise({
        try: async () => resolveExecutable(CredentialExecutable.OnePassword),
        catch: () =>
          credentialError(
            CredentialErrorCode.ProviderUnavailable,
            "The 1Password credential provider is not available.",
            { provider: "1password", name },
          ),
      }).pipe(
        Effect.flatMap((executable) => {
          if (!executable) {
            return Effect.fail(
              credentialError(
                CredentialErrorCode.ProviderUnavailable,
                "The 1Password credential provider is not available.",
                {
                  provider: "1password",
                  name,
                  recovery: "Install and configure the op CLI.",
                },
              ),
            );
          }
          return runner(executable, ["read", "--no-newline", entry.reference], {
            ...PROVIDER_PROCESS_OPTIONS,
          }).pipe(
            Effect.mapError((error) => providerFailure(error, "1password")),
            Effect.flatMap((output) => validateCredential(output.stdout, "1password", name)),
          );
        }),
      );
    },
  };
}

export function createBitwardenProvider(
  sessionSource: BitwardenSessionSource,
  runnerPath = join(import.meta.dirname, "bitwarden-runner.js"),
  runner: CredentialProcessRunner = streamProcess,
  resolveExecutable: CredentialExecutableResolver = () => CredentialExecutable.Bitwarden,
): CredentialProvider {
  return {
    id: "bitwarden",
    resolve(entry, name) {
      if (entry.provider !== "bitwarden") {
        return Effect.fail(
          credentialError(
            CredentialErrorCode.ProviderFailed,
            "The credential entry does not match the Bitwarden provider.",
            { provider: "bitwarden", name },
          ),
        );
      }
      return Effect.tryPromise({
        try: async () => resolveExecutable(CredentialExecutable.Bitwarden),
        catch: () =>
          credentialError(
            CredentialErrorCode.ProviderUnavailable,
            "The Bitwarden credential provider is not available.",
            { provider: "bitwarden", name },
          ),
      }).pipe(
        Effect.flatMap((executable) => {
          if (!executable) {
            return Effect.fail(
              credentialError(
                CredentialErrorCode.ProviderUnavailable,
                "The Bitwarden credential provider is not available.",
                {
                  provider: "bitwarden",
                  name,
                  recovery: "Install and configure the bw CLI.",
                },
              ),
            );
          }
          return sessionSource.use((session) =>
            runner(resolveNodeCommand(), [runnerPath, executable, entry.field, entry.itemId], {
              ...PROVIDER_PROCESS_OPTIONS,
              stdin: Buffer.from(`${Redacted.value(session)}\n`, "utf8"),
            }).pipe(
              Effect.mapError((error) => providerFailure(error, "bitwarden")),
              Effect.flatMap((output) => validateCredential(output.stdout, "bitwarden", name)),
            ),
          );
        }),
      );
    },
  };
}

export function providerMap(
  providers: readonly CredentialProvider[],
): ReadonlyMap<CredentialProvider["id"], CredentialProvider> {
  return new Map(providers.map((provider) => [provider.id, provider]));
}

export function guardProviderResolve(
  provider: CredentialProvider,
  entry: CredentialEntry,
  name: CredentialName,
): Effect.Effect<Redacted.Redacted<string>, ReturnType<typeof credentialError>> {
  return provider
    .resolve(entry, name)
    .pipe(Effect.mapError((error) => sanitizeProviderError(error, provider.id)));
}
