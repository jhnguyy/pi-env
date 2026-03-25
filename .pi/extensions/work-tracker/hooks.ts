/**
 * hooks.ts — pi lifecycle hook registrations for work-tracker.
 *
 *   tool_call hook       — branch guard (blocks git push to protected branches)
 *   tool_result hook     — handoff cleanup on merge / git pull
 *   session_start hook   — slot init, todo clear, tool deactivation
 *   session_switch hook  — todo clear on /new or /resume
 *   session_shutdown     — todo clear + slot state reset
 *   before_agent_start   — context injection (git status + todo list)
 */

import type { ExtensionAPI, ToolCallEventResult } from "@mariozechner/pi-coding-agent";
import { getMergedBranches } from "../_shared/git";
import { isOrchWorker } from "../_shared/context";
import { setSlot, resetSlots } from "../_shared/ui-render";

import type { BranchGuard } from "./branch-guard";
import { buildStatusLine, buildStatusLineThemed, getGitStatus, isGitMutating, invalidateGitCache } from "./context";
import {
  cleanupHandoffs,
  detectMergedBranch,
  isGitPull,
} from "./handoff-cleanup";
import type { TodoStore } from "./store";
import type { WorkTrackerConfig } from "./types";

export function registerHooks(
  pi: ExtensionAPI,
  config: WorkTrackerConfig,
  guard: BranchGuard,
  store: TodoStore,
): void {
  // ─── 1. Branch Guard ────────────────────────────────────────────────────────
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "bash") return;
    const command = (event.input as Record<string, string>).command ?? "";
    const result = guard.check(command);
    if (result.shouldBlock) {
      return { block: true, reason: result.reason } satisfies ToolCallEventResult;
    }
  });

  // ─── 2. Handoff cleanup on merge ────────────────────────────────────────────
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash" || event.isError) return;

    const command = (event.input as Record<string, string>).command ?? "";

    // Invalidate git status cache when bash commands modify git state
    if (isGitMutating(command)) invalidateGitCache();
    const output = (event.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");

    // Path A: local git merge
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

    // Path B: git pull on a protected branch
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

  // ─── 3. Session start ───────────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    store.clear();
    invalidateGitCache();
    setSlot("session-todos", store.renderWidget(ctx.ui.theme), ctx);
    setSlot("work-tracker", buildStatusLineThemed(config, ctx.ui.theme) ?? undefined, ctx);

    // Deactivate read_session in normal sessions — set PI_SESSION_READER=1 to keep it active.
    if (!process.env.PI_SESSION_READER) {
      pi.setActiveTools(pi.getActiveTools().filter((t) => t !== "read_session"));
    }
  });

  // ─── 4. Session switch (/new, /resume) — clear todos ───────────────────────
  pi.on("session_switch", async (_event, ctx) => {
    const open = store.open().length;
    store.clear();
    setSlot("session-todos", store.renderWidget(ctx.ui.theme), ctx);
    setSlot("work-tracker", buildStatusLineThemed(config, ctx.ui.theme) ?? undefined, ctx);
    if (open > 0) {
      ctx.ui.notify(`🗑️ Session switched — cleared ${open} open task${open === 1 ? "" : "s"}.`, "info");
    }
  });

  // ─── 5. Session shutdown — clear todos + slot state ─────────────────────────
  pi.on("session_shutdown", async () => {
    store.clear();
    resetSlots();
  });

  // ─── 6. Widget refresh on turn_end ──────────────────────────────────────────
  pi.on("turn_end", async (_event, ctx) => {
    if (isOrchWorker()) return;
    invalidateGitCache();
    setSlot("session-todos", store.renderWidget(ctx.ui.theme), ctx);
    setSlot("work-tracker", buildStatusLineThemed(config, ctx.ui.theme) ?? undefined, ctx);
  });

  // ─── 7. Widget refresh + context injection before agent start ───────────────
  pi.on("before_agent_start", async (_event, ctx) => {
    if (isOrchWorker()) return {};
    setSlot("session-todos", store.renderWidget(ctx.ui.theme), ctx);
    setSlot("work-tracker", buildStatusLineThemed(config, ctx.ui.theme) ?? undefined, ctx);

    const line = buildStatusLine(config); // plain text for LLM
    if (!line) return {};
    return { message: { customType: "work-tracker", content: line, display: false } };
  });

  // ─── 8. Todo context injection (root sessions only) ─────────────────────────
  // NOTE: Ideally this would be merged with hook 7 above into a single
  // before_agent_start handler, but BeforeAgentStartEventResult only supports
  // a single `message?` — not `messages[]`. Two hooks are needed until the
  // upstream pi API adds multi-message support.
  pi.on("before_agent_start", async () => {
    if (isOrchWorker()) return {};
    return { message: { customType: "session-todos", content: store.render(), display: false } };
  });
}
