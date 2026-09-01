import type { NotesSettings } from "./config";
import { NotesProviderError } from "./domain";
import { createObsidianProvider } from "./obsidian-provider";
import { registerNotesProvider } from "./provider-registry";

/** Register built-in providers. Other extension bundles register their own providers. */
export async function registerConfiguredBuiltinProvider(
  settings: NotesSettings,
): Promise<() => void> {
  if (settings.provider !== "obsidian") return () => {};
  if (settings.vaultPath === undefined) {
    throw new NotesProviderError({
      code: "invalid-provider",
      message: "The Obsidian notes provider requires an absolute vaultPath.",
    });
  }
  return registerNotesProvider(await createObsidianProvider(settings.vaultPath));
}
