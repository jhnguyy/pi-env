import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Effect } from "effect";

import { loadNotesSettingsEffect } from "./config";
import type { SettingsEnv } from "../_shared/settings";
import { createNotesContract, type NotesToolDetails } from "./contract";
import { registerConfiguredBuiltinProvider } from "./provider";
import { resolveNotesProvider } from "./provider-registry";
import { PiEvent, ToolCapability } from "../_shared/agent-tools";
import { registerCrossHostTool } from "../_shared/register-cross-host-tool";

export { registerNotesProvider } from "./provider-registry";
export type {
  NoteDocument,
  NoteEntry,
  NoteSearchResult,
  NotesArea,
  NotesDeleteRequest,
  NotesListRequest,
  NotesMutationResult,
  NotesProvider,
  NotesSearchRequest,
  NotesWriteRequest,
} from "./domain";

export default function (pi: ExtensionAPI) {
  return activateNotesExtension(pi);
}

export async function activateNotesExtension(
  pi: ExtensionAPI,
  cwd = process.cwd(),
  settingsEnv?: SettingsEnv,
): Promise<void> {
  const settings = await Effect.runPromise(loadNotesSettingsEffect(cwd, settingsEnv));
  if (settings === null) return;

  const unregisterBuiltin = await registerConfiguredBuiltinProvider(settings);
  pi.on(PiEvent.SessionShutdown, unregisterBuiltin);
  const contract = createNotesContract(() => resolveNotesProvider(settings.provider));

  registerCrossHostTool(pi, {
    contract,
    capabilities: [ToolCapability.Read, ToolCapability.Write],
    piOptions: {
      promptSnippet: "Search, read, and maintain notes in the configured store",
      promptGuidelines: [
        "Use notes for durable note operations when the notes tool is available.",
        "Never store secrets, credentials, private keys, tokens, or raw sensitive dumps in notes.",
      ],
      renderCall(args, theme) {
        let text = theme.fg("toolTitle", theme.bold("notes"));
        text += ` ${theme.fg("accent", String(args.action))}`;
        if (args.path) text += ` ${theme.fg("muted", String(args.path))}`;
        if (args.query) text += ` ${theme.fg("muted", `q=${String(args.query)}`)}`;
        return new Text(text, 0, 0);
      },
      renderResult(result, { expanded }, theme, context) {
        const rawText = result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n");
        if (expanded) return new Text(rawText, 0, 0);

        const details = result.details as NotesToolDetails | undefined;
        const count = details?.notes?.length ?? details?.results?.length;
        const suffix = count === undefined ? "" : ` (${count})`;
        return new Text(
          theme.fg("success", `✓ notes ${String(context.args.action)}${suffix}`),
          0,
          0,
        );
      },
    },
  });
}
