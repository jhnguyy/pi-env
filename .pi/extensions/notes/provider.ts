import type { Effect } from "effect";

import type { NotesSettings } from "./config";
import type { NotesProvider, NotesProviderError } from "./domain";
import { createObsidianProviderEffect } from "./obsidian-provider";

export function createNotesProviderEffect(
  settings: NotesSettings,
): Effect.Effect<NotesProvider, NotesProviderError> {
  switch (settings.provider) {
    case "obsidian":
      return createObsidianProviderEffect(settings.vaultPath);
  }
}
