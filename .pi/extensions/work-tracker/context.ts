/**
 * context.ts — git status helpers and widget refresh utilities.
 *
 * Pure side-effect-free git utilities (loadConfig, getGitStatus,
 * getCurrentBranch, buildStatusLine) plus per-repo caches for git status
 * and active worktrees that avoid spawning subprocesses on every agent turn.
 *
 * Cache invalidation: call invalidateGitCache() after any bash command
 * that modifies git state (commit, checkout, merge, push, pull, etc.).
 * Worktree cache is cleared on the same invalidation since `git worktree`
 * is already matched by GIT_MUTATING_PATTERN.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";

import { getCurrentBranch as gitGetCurrentBranch, getDirtyCount, gitSync } from "../_shared/git";
import type { WorkTrackerConfig } from "./types";

// ─── Config ───────────────────────────────────────────────────────────────────

export function loadConfig(): WorkTrackerConfig {
  const guardedRepos = process.env.WORK_TRACKER_REPOS
    ? process.env.WORK_TRACKER_REPOS.split(",").map((s) => s.trim())
    : [process.cwd()];

  const protectedBranches = process.env.WORK_TRACKER_PROTECTED
    ? process.env.WORK_TRACKER_PROTECTED.split(",").map((s) => s.trim())
    : ["main", "master"];

  return { guardedRepos, protectedBranches };
}

// ─── Git status cache ─────────────────────────────────────────────────────────

interface CachedGitStatus {
  branch: string | null;
  dirty: number;
}

/** Cached git status per repo path. Cleared on git-mutating bash commands. */
const gitStatusCache = new Map<string, CachedGitStatus>();

/** Cached worktree list per repo path. Cleared alongside gitStatusCache. */
const worktreeCache = new Map<string, string[]>();

/** Pattern matching bash commands that modify git state. */
const GIT_MUTATING_PATTERN = /\bgit\b.*\b(commit|checkout|switch|merge|rebase|pull|push|reset|stash|add|restore|cherry-pick|branch\s+-[dDmM]|worktree)\b/;

/** Returns true if a bash command could modify git state. */
export function isGitMutating(command: string): boolean {
  return GIT_MUTATING_PATTERN.test(command);
}

/** Clear both the git status cache and the worktree cache. */
export function invalidateGitCache(): void {
  gitStatusCache.clear();
  worktreeCache.clear();
}

// ─── Git status ───────────────────────────────────────────────────────────────

export function getGitStatus(repoPath: string): { branch: string | null; dirty: number } {
  const cached = gitStatusCache.get(repoPath);
  if (cached) return cached;

  const status = {
    branch: gitGetCurrentBranch(repoPath),
    dirty: getDirtyCount(repoPath),
  };
  gitStatusCache.set(repoPath, status);
  return status;
}

/** Get the branch of the current working directory. */
export function getCurrentBranch(): string | null {
  return gitGetCurrentBranch(process.cwd());
}

// ─── Active worktrees ─────────────────────────────────────────────────────────

/**
 * Return branch names of all active worktrees in repoPath, excluding the
 * primary worktree (always first in `git worktree list --porcelain` output).
 * Returns [] if the repo has no additional worktrees or on any error.
 */
export function getActiveWorktrees(repoPath: string): string[] {
  const cached = worktreeCache.get(repoPath);
  if (cached) return cached;

  const { status, stdout } = gitSync(repoPath, ["worktree", "list", "--porcelain"]);
  if (status !== 0 || !stdout.trim()) {
    worktreeCache.set(repoPath, []);
    return [];
  }

  // Each worktree block is separated by a blank line. The first block is the
  // primary worktree — skip it. Collect branch names from the rest.
  const blocks = stdout.split(/\n\n+/).filter(Boolean);
  const branches: string[] = [];
  for (const block of blocks.slice(1)) {
    for (const line of block.split("\n")) {
      if (line.startsWith("branch refs/heads/")) {
        branches.push(line.slice("branch refs/heads/".length).trim());
        break;
      }
    }
    // detached HEAD worktrees (no "branch" line) are skipped — they're not
    // named branches another agent would conflict with.
  }

  worktreeCache.set(repoPath, branches);
  return branches;
}

// ─── Status line ──────────────────────────────────────────────────────────────

/** Plain-text status line for LLM context injection. */
export function buildStatusLine(config: WorkTrackerConfig): string | null {
  const parts: string[] = [];
  for (const repoPath of config.guardedRepos) {
    const { branch, dirty } = getGitStatus(repoPath);
    if (!branch) continue;
    const name = repoPath.split("/").pop() ?? repoPath;
    const warn = config.protectedBranches.includes(branch) ? " (⚠️ protected branch)" : "";
    const dirtyNote = dirty > 0 ? ` (${dirty} uncommitted)` : "";

    const worktrees = getActiveWorktrees(repoPath);
    const worktreeNote = worktrees.length > 0
      ? ` | other worktrees: ${worktrees.join(", ")}`
      : "";

    parts.push(`${name}: ${branch}${warn}${dirtyNote}${worktreeNote}`);
  }
  return parts.length > 0 ? `[work-tracker] ${parts.join(" | ")}` : null;
}

/**
 * Themed status line for the TUI widget.
 * Label uses customMessageLabel + bold; branch uses accent; warnings use warning color.
 */
export function buildStatusLineThemed(config: WorkTrackerConfig, theme: Theme): string | null {
  const parts: string[] = [];
  for (const repoPath of config.guardedRepos) {
    const { branch, dirty } = getGitStatus(repoPath);
    if (!branch) continue;
    const name = repoPath.split("/").pop() ?? repoPath;
    const isProtected = config.protectedBranches.includes(branch);
    const warn = isProtected ? ` ${theme.fg("warning", "(⚠️ protected branch)")}` : "";
    const dirtyNote = dirty > 0 ? ` ${theme.fg("warning", `(${dirty} uncommitted)`)}` : "";

    const worktrees = getActiveWorktrees(repoPath);
    const worktreeNote = worktrees.length > 0
      ? ` ${theme.fg("muted", `| other worktrees: ${worktrees.join(", ")}`)}`
      : "";

    parts.push(`${name}: ${theme.fg("accent", branch)}${warn}${dirtyNote}${worktreeNote}`);
  }
  if (parts.length === 0) return null;
  const label = theme.fg("customMessageLabel", "\x1b[1m[work-tracker]\x1b[22m");
  return `${label} ${parts.join(" | ")}`;
}
