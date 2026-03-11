/**
 * context.ts — git status helpers and widget refresh utilities.
 *
 * Pure side-effect-free git utilities (loadConfig, getGitStatus,
 * getCurrentBranch, buildStatusLine) plus the refreshTodoWidget
 * helper that updates the TUI session-todos widget.
 */

import { spawnSync } from "node:child_process";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

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
  let branch: string | null = null;
  let dirty = 0;
  try {
    const b = spawnSync("git", ["-C", repoPath, "branch", "--show-current"], {
      encoding: "utf8",
      timeout: 3000,
    });
    if (b.status === 0 && b.stdout) branch = b.stdout.trim() || null;

    const s = spawnSync("git", ["-C", repoPath, "status", "--porcelain"], {
      encoding: "utf8",
      timeout: 3000,
    });
    if (s.status === 0 && s.stdout) {
      dirty = s.stdout.trim().split("\n").filter(Boolean).length;
    }
  } catch {
    // Ignore — repo may not exist
  }
  return { branch, dirty };
}

/** Get the branch of the current working directory. */
export function getCurrentBranch(): string | null {
  return getGitStatus(process.cwd()).branch;
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
  if (process.env.PI_AGENT_ID) return;
  ctx.ui.setWidget("session-todos", [store.render()], { placement: "belowEditor" });
}
