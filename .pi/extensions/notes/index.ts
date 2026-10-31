import { join } from "node:path";
import * as ChildContext from "../_shared/child-context";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Effect } from "effect";

import { loadNotesSettingsEffect } from "./config";
import * as Settings from "../_shared/settings";
import { createNotesContract, type NotesToolDetails } from "./contract";
import * as Provider from "./provider";
import { registerNotesProviderEventBridge } from "./provider-events";
import { resolveNotesProvider } from "./provider-registry";
import { createNotesPolicy, POLICY_UNAVAILABLE } from "./policy";
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
  const resolve = () => builtin ?? resolveNotesProvider(settings.provider);
  const policy = createNotesPolicy(resolve);
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    if ((await policy.reload()) === false) ctx.ui.notify(POLICY_UNAVAILABLE, "warning");
  });
  pi.on(AgentTools.PiEvent.SessionShutdown, async () => {
    await policy.shutdown();
    unregisterExternal();
  });
  pi.registerCommand("notes-reload", {
    description: "Reload the provider notes-policy entrypoint; block writes if it cannot load",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const loaded = await policy.reload();
      if (loaded === false) ctx.ui.notify(POLICY_UNAVAILABLE, "warning");
      else if (loaded === true) ctx.ui.notify("Notes policy reloaded.", "info");
    },
  });
  // Request-local conversation context cannot persist stale policy into resumed sessions.
  pi.on("context", (event) => ({
    messages: [
      { role: "user", content: policy.context(), timestamp: Date.now() },
      ...event.messages,
    ],
  }));
  const contract = createNotesContract(resolve, { assertWritable: policy.assertWritable });

  RegisterContractTool.registerContractTool(pi, {
    contract,
    piOptions: {
      promptSnippet: "Read and maintain provider-owned Markdown notes",
      promptGuidelines: [
        "Consult scoped notes-policy context and retrieve relevant destination contracts before notes mutations.",
        "Use notes index for orientation and list for authoritative inventory; the provider owns organization.",
        "Never store secrets, credentials, private keys, tokens, or raw sensitive dumps in notes.",
      ],
      renderCall(args, theme) {
        let text = theme.fg("toolTitle", theme.bold("notes"));
        text += ` ${theme.fg("accent", String(args.action))}`;
        const subject = args.path;
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
