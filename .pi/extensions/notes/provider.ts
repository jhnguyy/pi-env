import type { NotesSettings } from "./config";
import { NotesProviderError, type NotesProvider } from "./domain";
import { createObsidianProvider } from "./obsidian-provider";

/** Configured built-ins belong to one extension owner; external providers use the registry. */
export async function createConfiguredBuiltinProvider(
  settings: NotesSettings,
): Promise<NotesProvider | undefined> {
  if (settings.provider !== "obsidian") return undefined;
  if (settings.vaultPath === undefined) {
    throw new NotesProviderError({
      code: "invalid-provider",
      message: "The Obsidian notes provider requires an absolute vaultPath.",
    });
  }
  return createObsidianProvider(settings.vaultPath);
}
