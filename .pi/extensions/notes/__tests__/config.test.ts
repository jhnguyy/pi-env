import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import { loadNotesSettingsEffect } from "../config";
import { SettingsDecodeError, type SettingsEnv } from "../../_shared/settings";

function settingsEnv(global: unknown, project?: unknown): SettingsEnv {
  const files = new Map<string, string>();
  if (global !== undefined) files.set("/global/settings.json", JSON.stringify(global));
  if (project !== undefined) files.set("/repo/.pi/settings.json", JSON.stringify(project));
  return {
    globalSettingsPath: () => "/global/settings.json",
    projectSettingsPath: () => "/repo/.pi/settings.json",
    readFile: (filePath) => {
      const content = files.get(filePath);
      if (content !== undefined) return content;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  };
}

describe("notes settings", () => {
  it.effect("leaves the extension inactive when notes settings are absent", () =>
    Effect.gen(function* () {
      expect(yield* loadNotesSettingsEffect("/repo", settingsEnv({}))).toBeNull();
    }),
  );

  it.effect("decodes an absolute Obsidian vault path", () =>
    Effect.gen(function* () {
      const settings = yield* loadNotesSettingsEffect(
        "/repo",
        settingsEnv({
          notes: { provider: "obsidian", vaultPath: "/vault" },
        }),
      );

      expect(settings).toEqual({ provider: "obsidian", vaultPath: "/vault" });
    }),
  );

  it.effect("lets trusted project settings select the active vault", () =>
    Effect.gen(function* () {
      const settings = yield* loadNotesSettingsEffect(
        "/repo",
        settingsEnv(
          { notes: { provider: "obsidian", vaultPath: "/personal" } },
          { notes: { vaultPath: "/work" } },
        ),
      );

      expect(settings).toEqual({ provider: "obsidian", vaultPath: "/work" });
    }),
  );

  it.effect("accepts external provider selection without provider-specific settings", () =>
    Effect.gen(function* () {
      expect(
        yield* loadNotesSettingsEffect(
          "/repo",
          settingsEnv({ notes: { provider: "notes-assistant" } }),
        ),
      ).toEqual({ provider: "notes-assistant" });
    }),
  );

  it.effect("rejects empty provider IDs and relative Obsidian vault paths", () =>
    Effect.gen(function* () {
      const provider = yield* Effect.result(
        loadNotesSettingsEffect("/repo", settingsEnv({ notes: { provider: "" } })),
      );
      const path = yield* Effect.result(
        loadNotesSettingsEffect(
          "/repo",
          settingsEnv({
            notes: { provider: "obsidian", vaultPath: "relative/vault" },
          }),
        ),
      );

      expect(provider._tag).toBe("Failure");
      if (provider._tag === "Failure") expect(provider.failure).toBeInstanceOf(SettingsDecodeError);
      expect(path._tag).toBe("Failure");
      if (path._tag === "Failure") expect(path.failure).toBeInstanceOf(SettingsDecodeError);
    }),
  );
});
