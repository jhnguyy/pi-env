/**
 * context.ts — git status helpers and widget refresh utilities.
 *
 * Pure side-effect-free git utilities (loadConfig, getGitStatus,
 * getCurrentBranch, buildStatusLine) plus the refreshTodoWidget
 * helper that updates the TUI session-todos widget.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { getCurrentBranch as gitGetCurrentBranch, getDirtyCount } from "../_shared/git";
import { isHeadless } from "../_shared/context";
import type { TodoStore } from "./store";
import type { WorkTrackerConfig } from "./types";

// ─── Config ───────────────────────────────────────────────────────────────────

export function loadConfig(): WorkTrackerConfig {
  const guardedRepos = process.env.WORK_TRACKER_REPOS
    ? process.env.WORK_TRACKER_REPOS.split(",").map((s) => s.trim())
    : ["/mnt/tank/code/pi-env"];

  const protectedBranches = process.env.WORK_TRACKER_PROTECTED
    ? process.env.WORK_TRACKER_PROTECTED.split(",").map((s) => s.trim())
    : ["main", "master"];

  return { guardedRepos, protectedBranches };
}

// ─── Git status ───────────────────────────────────────────────────────────────

export function getGitStatus(repoPath: string): { branch: string | null; dirty: number } {
  return {
    branch: gitGetCurrentBranch(repoPath),
    dirty: getDirtyCount(repoPath),
  };
}

/** Get the branch of the current working directory. */
export function getCurrentBranch(): string | null {
  return gitGetCurrentBranch(process.cwd());
}

// ─── Status line ──────────────────────────────────────────────────────────────

export function buildStatusLine(config: WorkTrackerConfig): string | null {
  const parts: string[] = [];
  for (const repoPath of config.guardedRepos) {
    const { branch, dirty } = getGitStatus(repoPath);
    if (!branch) continue;
    const name = repoPath.split("/").pop() ?? repoPath;
    const warn = config.protectedBranches.includes(branch) ? " (⚠️ protected branch)" : "";
    const dirtyNote = dirty > 0 ? ` (${dirty} uncommitted)` : "";
    parts.push(`${name}: ${branch}${warn}${dirtyNote}`);
  }
  return parts.length > 0 ? `[work-tracker] ${parts.join(" | ")}` : null;
}

// ─── Widget refresh ───────────────────────────────────────────────────────────

export function refreshTodoWidget(store: TodoStore, ctx: ExtensionContext): void {
  if (isHeadless(ctx)) return;
  ctx.ui.setWidget("session-todos", [store.render()], { placement: "belowEditor" });
}
