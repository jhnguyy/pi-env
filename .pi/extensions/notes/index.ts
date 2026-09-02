import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Effect } from "effect";

import { loadNotesSettingsEffect } from "./config";
import type { SettingsEnv } from "../_shared/settings";
import { createNotesContract, type NotesToolDetails } from "./contract";
import { registerConfiguredBuiltinProvider } from "./provider";
import { registerNotesProviderEventBridge } from "./provider-events";
import { resolveNotesProvider } from "./provider-registry";
import { PiEvent, ToolCapability } from "../_shared/agent-tools";
import { registerCrossHostTool } from "../_shared/register-cross-host-tool";

export { NotesProviderError } from "./domain";
export { NotesProviderEvent } from "./provider-events";
export type { NotesProviderRegistration } from "./provider-events";
export { registerNotesProvider } from "./provider-registry";
export type {
  NoteDocument,
  NoteEntry,
  NoteSearchResult,
  NotesDeleteRequest,
  NotesIndex,
  NotesListRequest,
  NotesMutationResult,
  NotesProvider,
  NotesProviderErrorCode,
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

  const unregisterExternal = registerNotesProviderEventBridge(pi);
  const unregisterBuiltin = await registerConfiguredBuiltinProvider(settings);
  pi.on(PiEvent.SessionShutdown, () => {
    unregisterBuiltin();
    unregisterExternal();
  });
  const contract = createNotesContract(() => resolveNotesProvider(settings.provider));

  registerCrossHostTool(pi, {
    contract,
    capabilities: [ToolCapability.Read, ToolCapability.Write],
    piOptions: {
      promptSnippet: "Discover, read, and maintain Markdown notes in the configured store",
      promptGuidelines: [
        "Use notes index before the first store interaction in a task. Follow the provider-owned conventions that it returns.",
        "Use notes list with a prefix for authoritative inventory. Do not invent note paths or storage conventions.",
        "Use notes read before changing an existing note. Pass its revision to edit, write, or delete so concurrent changes fail safely.",
        "Use notes edit for small exact changes. Use notes write for a coherent rewrite when the note structure or meaning changes.",
        "Create durable notes only when future retrieval is expected and the destination is clear from the store index or nearby notes.",
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
