/**
 * hooks.ts — pi lifecycle hook registrations for work-tracker.
 *
 *   tool_call hook       — branch guard (blocks git push to protected branches)
 *   tool_result hook     — handoff cleanup on merge / git pull
 *   session_start hook   — widget init, todo clear, tool deactivation
 *   session_switch hook  — todo clear on /new or /resume
 *   session_shutdown     — todo clear on exit
 *   before_agent_start   — context injection (git status + todo list)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMergedBranches } from "../_shared/git";

import type { BranchGuard } from "./branch-guard";
import { buildStatusLine, getGitStatus, refreshTodoWidget } from "./context";
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
    if (event.toolName !== "bash") return undefined;
    const command = (event.input as Record<string, string>).command ?? "";
    const result = guard.check(command);
    if (result.shouldBlock) {
      return { block: true, reason: result.reason };
    }
    return undefined;
  });

  // ─── 2. Handoff cleanup on merge ────────────────────────────────────────────
  //
  // Path A — local git merge (fast-forward or merge commit):
  //   Fires when the agent runs `git merge <branch>` directly.
  //
  // Path B — git pull on a protected branch (GitHub PR merge workflow):
  //   After any git pull, checks each guarded repo. If we're on a protected
  //   branch, collects all locally-known merged branches and cleans up their
  //   handoffs. This covers the common flow: PR merges on GitHub → agent runs
  //   `git checkout main && git pull`.
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash" || event.isError) return;

    const command = (event.input as Record<string, string>).command ?? "";
    const output = (event.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");

    // ── Path A: local git merge ────────────────────────────────────
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

    // ── Path B: git pull on a protected branch ─────────────────────
    if (!isGitPull(command)) return;

    const allMerged = new Set<string>();
    for (const repoPath of config.guardedRepos) {
      const { branch: current } = getGitStatus(repoPath);
      if (!current || !config.protectedBranches.includes(current)) continue;

      for (const branch of getMergedBranches(repoPath)) {
        if (!config.protectedBranches.includes(branch)) {
          allMerged.add(branch);
        }
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

  // ─── 3. Session start — widget init, todo clear, tool deactivation ──────────
  pi.on("session_start", async (_event, ctx) => {
    store.clear();

    if (process.env.PI_AGENT_ID) return;

    const line = buildStatusLine(config);
    if (line) ctx.ui.setWidget("work-tracker", [line], { placement: "belowEditor" });

    refreshTodoWidget(store, ctx);

    // Deactivate read_session in normal sessions — set PI_SESSION_READER=1 to keep it active.
    if (!process.env.PI_SESSION_READER) {
      pi.setActiveTools(pi.getActiveTools().filter((t) => t !== "read_session"));
    }
  });

  // ─── 4. Session switch (/new, /resume) — clear todos ───────────────────────
  pi.on("session_switch", async (_event, ctx) => {
    const open = store.open().length;
    store.clear();
    if (process.env.PI_AGENT_ID) return;
    refreshTodoWidget(store, ctx);
    if (open > 0) {
      ctx.ui.notify(`🗑️ Session switched — cleared ${open} open task${open === 1 ? "" : "s"}.`, "info");
    }
  });

  // ─── 5. Session shutdown (exit) — clear todos ───────────────────────────────
  pi.on("session_shutdown", async () => {
    store.clear();
  });

  // ─── 6. Context injection + widget refresh (root sessions only) ─────────────
  pi.on("before_agent_start", async (_event, ctx) => {
    if (process.env.PI_AGENT_ID) return {};

    const line = buildStatusLine(config);
    if (line) ctx.ui.setWidget("work-tracker", [line], { placement: "belowEditor" });
    refreshTodoWidget(store, ctx);

    if (!line) return {};
    return {
      message: {
        customType: "work-tracker",
        content: line,
        display: false,
      },
    };
  });

  // ─── 7. Todo context injection (root sessions only) ─────────────────────────
  pi.on("before_agent_start", async () => {
    if (process.env.PI_AGENT_ID) return {};
    return {
      message: {
        customType: "session-todos",
        content: store.render(),
        display: false,
      },
    };
  });
}
