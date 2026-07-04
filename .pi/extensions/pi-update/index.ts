import { basename } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildDecisionPrompt } from "./artifacts";
import { parseArgs } from "./args";
import { isPiUpdateEnabled, preparePiUpdate } from "./workflow";

export type { PiUpdateOptions, PiUpdatePrep } from "./contract";
export { buildDecisionPrompt, extractChangelogSection, isPiPackageName, packageNames, packageNamesEither, writeInstallCommand, writeReport } from "./artifacts";
export { parseArgs } from "./args";
export { PiUpdateError, PiUpdatePhase } from "./errors";
export { isPiUpdateEnabled, preparePiUpdate, preparePiUpdateEffect } from "./workflow";

export default function piUpdateExtension(pi: ExtensionAPI) {
  if (!isPiUpdateEnabled()) return;

  pi.registerCommand("pi-update", {
    description:
      "Prepare a pi dependency update worktree and changelog review, then hand off the decision task to the agent. Usage: /pi-update [version|latest] [--repo PATH] [--worktree-dir PATH]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const options = parseArgs(args);
      ctx.ui.notify(`Preparing pi update (${options.version})...`, "info");
      try {
        const prep = await preparePiUpdate(pi.exec.bind(pi), options);
        ctx.ui.notify(`pi update artifacts prepared for ${basename(prep.worktree)}`, "info");
        pi.sendUserMessage(buildDecisionPrompt(prep));
      } catch (error) {
        ctx.ui.notify(`pi-update failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
