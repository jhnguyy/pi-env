import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { applyCleanupPlan, buildCleanupPlan, formatCleanupPlan, parseCleanupArgs } from "./cleanup-core";

export function registerCleanupCommand(pi: ExtensionAPI) {
  pi.registerCommand("cleanup", {
    description:
      "Plan or apply cleanup of merged local git worktrees and branches. Dry-run by default; runs git fetch --prune origin unless --no-fetch is passed. Use `/cleanup apply` for safe ancestry-proven cleanup, `/cleanup apply --force` for remote-gone squash-merge cleanup, and `--repo <path>` outside the session cwd.",
    handler: async (args, ctx) => {
      try {
        const options = parseCleanupArgs(args);
        const plan = buildCleanupPlan(ctx.cwd, options);
        const actions = applyCleanupPlan(plan, options);
        const applied = options.apply;
        const actionText = actions.length > 0 ? `\n\nActions:\n${actions.map((action) => `- ${action}`).join("\n")}` : "";
        ctx.ui.notify(`${formatCleanupPlan(plan, applied)}${actionText}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Cleanup failed: ${message}`, "error");
      }
    },
  });
}
