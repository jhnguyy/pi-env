import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { PiEvent } from "../_shared/agent-tools";
import { getMergedBranches } from "../_shared/git";

import { buildStatusLine, buildStatusLineThemed, getGitStatus, isGitMutating, invalidateGitCache, resetGitFailureCache } from "./context";
import {
  cleanupHandoffs,
  detectMergedBranch,
  isGitPull,
} from "./handoff-cleanup";
import type { TodoStore } from "./store";
import type { WorkTrackerConfig } from "./types";

const SessionStartReason = {
  New: "new",
  Resume: "resume",
  Fork: "fork",
} as const;
type SessionStartReason = typeof SessionStartReason[keyof typeof SessionStartReason];

const REPLACEMENT_SESSION_REASONS = new Set<string>([
  SessionStartReason.New,
  SessionStartReason.Resume,
  SessionStartReason.Fork,
]);

function refreshWorkTrackerSlots(
  ctx: ExtensionContext,
  config: WorkTrackerConfig,
  store: TodoStore,
  options: { includeGitStatus: boolean },
): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget("session-todos", store.renderWidget(ctx.ui.theme), { placement: "aboveEditor" });
  const statusLine = options.includeGitStatus ? buildStatusLineThemed(config, ctx.ui.theme) : undefined;
  ctx.ui.setWidget("work-tracker", statusLine ? [statusLine] : undefined, { placement: "belowEditor" });
}

export function registerHooks(
  pi: ExtensionAPI,
  config: WorkTrackerConfig,
  store: TodoStore,
): void {
  pi.on(PiEvent.ToolResult, async (event, ctx) => {
    if (event.toolName !== "bash" || event.isError) return;

    const command = (event.input as Record<string, string>).command ?? "";

    if (isGitMutating(command)) invalidateGitCache();
    const output = (event.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");

    const mergedBranch = detectMergedBranch(command, output);
    if (mergedBranch) {
      const deleted = cleanupHandoffs(mergedBranch);
      if (deleted.length > 0) {
        ctx.ui.notify(
          `🧹 Merged ${mergedBranch} — deleted ${deleted.length} handoff(s): ${deleted.join(", ")}`,
          "info",
        );
      }
      return;
    }

    if (!isGitPull(command)) return;

    const allMerged = new Set<string>();
    for (const repoPath of config.guardedRepos) {
      const { branch: current } = getGitStatus(repoPath);
      if (!current || !config.protectedBranches.includes(current)) continue;
      for (const branch of getMergedBranches(repoPath)) {
        if (!config.protectedBranches.includes(branch)) allMerged.add(branch);
      }
    }

    if (allMerged.size === 0) return;
    const deleted = cleanupHandoffs(allMerged);
    if (deleted.length > 0) {
      ctx.ui.notify(
        `🧹 Pulled main — deleted ${deleted.length} handoff(s): ${deleted.join(", ")}`,
        "info",
      );
    }
  });

  pi.on(PiEvent.SessionStart, async (event, ctx) => {
    const open = store.open().length;
    const isReplacementSession = REPLACEMENT_SESSION_REASONS.has(event.reason);

    store.clear();
    invalidateGitCache();
    resetGitFailureCache();

    // Skip git status on startup — spawning git subprocesses synchronously at
    // session_start blocks in environments with many or slow mount points.
    // Replacement sessions refresh status because the cwd/session may change.
    refreshWorkTrackerSlots(ctx, config, store, { includeGitStatus: isReplacementSession });

    if (isReplacementSession && open > 0) {
      ctx.ui.notify(`Session switched. Cleared ${open} open task${open === 1 ? "" : "s"}.`, "info");
    }
  });

  pi.on(PiEvent.SessionShutdown, async () => {
    store.clear();
    resetGitFailureCache();
  });

  pi.on(PiEvent.TurnEnd, async (_event, ctx) => {
    invalidateGitCache();
    refreshWorkTrackerSlots(ctx, config, store, { includeGitStatus: true });
  });

  pi.on(PiEvent.BeforeAgentStart, async (_event, ctx) => {
    store.purgeCompleted();
    refreshWorkTrackerSlots(ctx, config, store, { includeGitStatus: true });

    const line = buildStatusLine(config);
    if (!line) return {};
    return { message: { customType: "work-tracker", content: line, display: false } };
  });

  pi.on(PiEvent.BeforeAgentStart, async () => {
    const context = store.renderContext();
    if (!context) return {};
    return { message: { customType: "session-todos", content: context, display: false } };
  });
}
