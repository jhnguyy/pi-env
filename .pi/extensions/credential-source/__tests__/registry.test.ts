import { beforeEach, describe, expect, it } from "vitest";
import {
  CredentialErrorCode,
  getCredentialSource,
  registerCredentialSource,
  resetCredentialSourceRegistryForTests,
  type CredentialSource,
} from "../../_shared/credential-source";

const source: CredentialSource = {
  has: () => true,
  use: async (_request, consume) => consume("test"),
};

describe("credential source registry", () => {
  beforeEach(() => resetCredentialSourceRegistryForTests());

  it("replays one source across bundle-local imports", async () => {
    const secondImport = await import("../../_shared/credential-source");
    const unregister = registerCredentialSource(source);

    expect(secondImport.getCredentialSource()).toBe(source);

    unregister();
    expect(() => getCredentialSource()).toThrow(
      expect.objectContaining({ code: CredentialErrorCode.SourceUnavailable }),
    );
  });

  it("does not let stale shutdown remove a replacement registration", () => {
    const replacement = { ...source, has: () => false };
    const unregisterOld = registerCredentialSource(source);
    const unregisterReplacement = registerCredentialSource(replacement);

    unregisterOld();
    expect(getCredentialSource()).toBe(replacement);

    unregisterReplacement();
    expect(() => getCredentialSource()).toThrow();
  });
});
