import { Effect, Redacted } from "effect";
import { describe, expect, it, vi } from "vitest";
import { CredentialErrorCode, CredentialSourceError } from "../../_shared/credential-source";
import type { CredentialProvider } from "../providers";
import { CredentialSourceRuntime } from "../source";

const SENTINEL = "SECRET_SENTINEL_DO_NOT_LEAK";
const entry = {
  provider: "1password" as const,
  consumers: ["linear"],
  account: "Work",
  reference: "op://Private/Linear/credential",
};

describe("credential source scoped use", () => {
  it("delivers a fixed logical credential only inside the consumer callback", async () => {
    const provider: CredentialProvider = {
      id: "1password",
      resolve: vi.fn(() => Effect.succeed(Redacted.make(SENTINEL))),
    };
    const source = new CredentialSourceRuntime(
      { "linear.apiKey": entry },
      new Map([[provider.id, provider]]),
    );

    expect(source.has("linear.apiKey")).toBe(true);
    expect(source.has("linear.otherKey")).toBe(false);
    await expect(
      source.use({ name: "linear.apiKey", consumer: "linear" }, async (value) => {
        expect(value).toBe(SENTINEL);
        return "complete";
      }),
    ).resolves.toBe("complete");
    expect(provider.resolve).toHaveBeenCalledOnce();
  });

  it("wipes the redacted provider value after callback success and failure", async () => {
    for (const fail of [false, true]) {
      const wrapped = Redacted.make(SENTINEL);
      const provider: CredentialProvider = {
        id: "1password",
        resolve: () => Effect.succeed(wrapped),
      };
      const source = new CredentialSourceRuntime(
        { "linear.apiKey": entry },
        new Map([[provider.id, provider]]),
      );
      const operation = source.use({ name: "linear.apiKey", consumer: "linear" }, async () => {
        if (fail) throw new Error("consumer failed");
        return undefined;
      });
      if (fail) await expect(operation).rejects.toThrow("consumer failed");
      else await operation;
      expect(() => Redacted.value(wrapped)).toThrow("Unable to get redacted value");
    }
  });

  it("denies consumers that are not allowed by the global mapping", async () => {
    const provider: CredentialProvider = {
      id: "1password",
      resolve: vi.fn(() => Effect.succeed(Redacted.make(SENTINEL))),
    };
    const source = new CredentialSourceRuntime(
      { "linear.apiKey": entry },
      new Map([[provider.id, provider]]),
    );

    await expect(
      source.use({ name: "linear.apiKey", consumer: "other" }, async () => undefined),
    ).rejects.toMatchObject({ code: CredentialErrorCode.AccessDenied });
    expect(provider.resolve).not.toHaveBeenCalled();
  });

  it("returns typed errors without exposing provider output", async () => {
    const provider: CredentialProvider = {
      id: "1password",
      resolve: () =>
        Effect.fail(
          new CredentialSourceError({
            code: CredentialErrorCode.ProviderFailed,
            message: "The 1Password credential provider failed.",
            retryable: true,
          }),
        ),
    };
    const source = new CredentialSourceRuntime(
      { "linear.apiKey": entry },
      new Map([[provider.id, provider]]),
    );

    try {
      await source.use({ name: "linear.apiKey", consumer: "linear" }, async () => undefined);
      throw new Error("Expected credential failure.");
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(SENTINEL);
      expect((error as Error).message).not.toContain(SENTINEL);
    }
  });
});
