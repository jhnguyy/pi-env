import { Effect, Redacted } from "effect";
import { CredentialErrorCode, type CredentialSourceError } from "../_shared/credential-source";
import { credentialError } from "./errors";
import type { BitwardenSessionSource } from "./providers";

export interface BitwardenSessionPrompt {
  (): Promise<string | undefined>;
}

export class PromptedBitwardenSessionSource implements BitwardenSessionSource {
  readonly #prompt: BitwardenSessionPrompt;

  constructor(prompt: BitwardenSessionPrompt) {
    this.#prompt = prompt;
  }

  use<T>(
    consume: (session: Redacted.Redacted<string>) => Effect.Effect<T, CredentialSourceError>,
  ): Effect.Effect<T, CredentialSourceError> {
    return Effect.acquireUseRelease(
      Effect.tryPromise({
        try: this.#prompt,
        catch: () =>
          credentialError(
            CredentialErrorCode.AuthenticationRequired,
            "Bitwarden session input failed.",
            { provider: "bitwarden", retryable: true },
          ),
      }).pipe(
        Effect.flatMap((value) => {
          const session = value?.trim();
          return session
            ? Effect.succeed(Redacted.make(session, { label: "bitwarden-session" }))
            : Effect.fail(
                credentialError(
                  CredentialErrorCode.AuthenticationRequired,
                  "Bitwarden requires an unlocked vault session.",
                  {
                    provider: "bitwarden",
                    retryable: true,
                    recovery: "Unlock Bitwarden and paste a new session key when Pi requests it.",
                  },
                ),
              );
        }),
      ),
      consume,
      (session) => Effect.sync(() => void Redacted.wipeUnsafe(session)),
    );
  }
}
