import type { NotesSettings } from "./config";
import * as Domain from "./domain";
import { createObsidianProvider } from "./obsidian-provider";

/** Configured built-ins belong to one extension owner; external providers use the registry. */
export async function createConfiguredBuiltinProvider(
  settings: NotesSettings,
): Promise<Domain.NotesProvider | undefined> {
  if (settings.provider !== "obsidian") return undefined;
  if (settings.vaultPath === undefined) {
    throw new Domain.NotesProviderError({
      code: "invalid-provider",
      message: "The Obsidian notes provider requires an absolute vaultPath.",
    });
  }
  return createObsidianProvider(settings.vaultPath);
}
