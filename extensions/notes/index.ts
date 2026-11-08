import { join } from "node:path";
import * as ChildContext from "../_shared/child-context";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Effect } from "effect";

import { loadNotesSettingsEffect } from "./config";
import * as Settings from "../_shared/settings";
import { NOTES_PROMPT_GUIDELINES, type NotesToolDetails } from "./contract";
import { createCodingAgentNotesContract } from "./coding-agent";
import * as Provider from "./provider";
import { registerNotesProviderEventBridge } from "./provider-events";
import { resolveNotesProvider } from "./provider-registry";
import * as AgentTools from "../_shared/agent-tools";
import * as RegisterContractTool from "../_shared/register-contract-tool";

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
  cwd = ChildContext.getChildContext()?.cwd ?? process.cwd(),
  settingsEnv?: Settings.SettingsEnv,
): Promise<void> {
  const child = ChildContext.getChildContext();
  settingsEnv ??= child
    ? {
        ...Settings.defaultSettingsEnv,
        globalSettingsPath: () => join(child.agentDir, "settings.json"),
      }
    : undefined;
  const settings = await Effect.runPromise(loadNotesSettingsEffect(cwd, settingsEnv));
  if (settings === null) return;

  const builtin = await Provider.createConfiguredBuiltinProvider(settings);
  const unregisterExternal = registerNotesProviderEventBridge(pi);
  pi.on(AgentTools.PiEvent.SessionShutdown, unregisterExternal);
  const contract = createCodingAgentNotesContract(
    () => builtin ?? resolveNotesProvider(settings.provider),
  );

  RegisterContractTool.registerContractTool(pi, {
    contract,
    piOptions: {
      promptSnippet: "Maintain Inbox, Projects, Wiki, Worklog, and other Markdown notes",
      promptGuidelines: NOTES_PROMPT_GUIDELINES,
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
