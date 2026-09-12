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
  NotesListResponse,
  NotesListResult,
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
      promptSnippet: "Read and maintain Inbox, Worklog, Wiki, and other Markdown notes",
      promptGuidelines: [
        "Use the Inbox, Worklog, and Wiki collection actions for their defined behaviors. Pi-env owns their canonical paths and lifecycle semantics.",
        "Use Store index before the first general store interaction in a task. Use Store list for authoritative legacy or adapter-owned inventory and Store search for global retrieval.",
        "Inbox reads are non-destructive. Inbox writes capture text without classifying, routing, promoting, rewriting, or deleting it.",
        "Record only brief completed-work outcomes in Worklog. Do not use Worklog for plans, current project state, or session narrative.",
        "Use Wiki for maintained current knowledge. Integrate coherent updates instead of appending session logs.",
        "Use the revision returned by a Wiki or Store read for updates so concurrent changes fail safely. Use a null revision only for explicit creation.",
        "Use transitional Store mutation only for bounded maintenance and migration work.",
        "Never store secrets, credentials, private keys, tokens, or raw sensitive dumps in notes.",
      ],
      renderCall(args, theme) {
        let text = theme.fg("toolTitle", theme.bold("notes"));
        if (args.collection) text += ` ${theme.fg("accent", String(args.collection))}`;
        text += ` ${theme.fg("accent", String(args.action))}`;
        const subject =
          ("target" in args ? args.target : undefined) ??
          ("path" in args ? args.path : undefined) ??
          ("selector" in args ? args.selector : undefined) ??
          ("date" in args ? args.date : undefined);
        if (subject) text += ` ${theme.fg("muted", String(subject))}`;
        const query = "query" in args ? args.query : undefined;
        if (query) text += ` ${theme.fg("muted", `q=${String(query)}`)}`;
        return new Text(text, 0, 0);
      },
      renderResult(result, { expanded }, theme, context) {
        const rawText = result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n");
        if (expanded) return new Text(rawText, 0, 0);

        const details = result.details as NotesToolDetails | undefined;
        const count = details?.items?.length ?? details?.notes?.length ?? details?.results?.length;
        const suffix = count === undefined ? "" : ` (${count})`;
        const collection = context.args.collection ? ` ${String(context.args.collection)}` : "";
        return new Text(
          theme.fg("success", `✓ notes${collection} ${String(context.args.action)}${suffix}`),
          0,
          0,
        );
      },
    },
  });
}
