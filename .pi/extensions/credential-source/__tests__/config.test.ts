import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { SettingsEnv } from "../../_shared/settings";
import { SettingsDecodeError, SettingsSource } from "../../_shared/settings";
import { loadCredentialSourceSettingsEffect } from "../config";

function envWith(globalValue: unknown, projectValue?: unknown): SettingsEnv {
  const files: Record<string, string> = {
    "/global/settings.json": JSON.stringify(globalValue),
    ...(projectValue === undefined
      ? {}
      : { "/repo/.pi/settings.json": JSON.stringify(projectValue) }),
  };
  return {
    globalSettingsPath: () => "/global/settings.json",
    projectSettingsPath: () => "/repo/.pi/settings.json",
    readFile: (path) => {
      if (path in files) return files[path];
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  };
}

describe("credential source settings", () => {
  it("decodes provider-neutral global mappings", async () => {
    const settings = await Effect.runPromise(
      loadCredentialSourceSettingsEffect(
        "/repo",
        envWith({
          credentialSource: {
            entries: {
              "linear.apiKey": {
                provider: "1password",
                consumers: ["linear"],
                reference: "op://Private/Linear/credential",
              },
              "forgejo.apiToken": {
                provider: "bitwarden",
                consumers: ["forgejo"],
                itemId: "12345678-1234-1234-1234-123456789abc",
                field: "password",
              },
            },
          },
        }),
      ),
    );

    expect(settings.entries["linear.apiKey"]).toMatchObject({ provider: "1password" });
    expect(settings.entries["forgejo.apiToken"]).toMatchObject({ provider: "bitwarden" });
  });

  it("rejects project additions and overrides before provider use", async () => {
    const result = await Effect.runPromise(
      Effect.result(
        loadCredentialSourceSettingsEffect(
          "/repo",
          envWith(
            {
              credentialSource: {
                entries: {
                  "linear.apiKey": {
                    provider: "1password",
                    consumers: ["linear"],
                    reference: "op://Private/Linear/credential",
                  },
                },
              },
            },
            {
              credentialSource: {
                entries: {
                  "linear.apiKey": {
                    provider: "bitwarden",
                    consumers: ["linear"],
                    itemId: "12345678-1234-1234-1234-123456789abc",
                    field: "password",
                  },
                },
              },
            },
          ),
        ),
      ),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(SettingsDecodeError);
      expect(result.failure).toMatchObject({
        source: SettingsSource.Project,
        path: "/repo/.pi/settings.json",
        key: "credentialSource",
      });
    }
  });

  it("rejects arbitrary provider commands and unknown providers", async () => {
    for (const entry of [
      {
        provider: "shell",
        command: "printf",
        args: ["secret"],
      },
      {
        provider: "1password",
        consumers: ["linear"],
        reference: "op://Private/Linear/credential",
        command: "op",
      },
    ]) {
      await expect(
        Effect.runPromise(
          loadCredentialSourceSettingsEffect(
            "/repo",
            envWith({ credentialSource: { entries: { "linear.apiKey": entry } } }),
          ),
        ),
      ).rejects.toBeInstanceOf(SettingsDecodeError);
    }
  });
});
