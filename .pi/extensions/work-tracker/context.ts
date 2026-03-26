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
 *
 * Config resolution order (first wins):
 *   1. WORK_TRACKER_REPOS / WORK_TRACKER_PROTECTED env vars  — CI / shell overrides
 *   2. settings.json `workTracker` key                        — normal user config
 *   3. process.cwd()                                          — fallback
 *
 * settings.json shape:
 *   {
 *     "workTracker": {
 *       "repos": ["/path/to/repo1", "/path/to/repo2"],
 *       "protectedBranches": ["main", "master"]   // optional, defaults to ["main","master"]
 *     }
 *   }
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

import { getCurrentBranch as gitGetCurrentBranch, getDirtyCount, gitSync } from "../_shared/git";
import type { WorkTrackerConfig } from "./types";

// ─── Config ───────────────────────────────────────────────────────────────────

/** Read the `workTracker` block from settings.json, if present. */
function readSettingsConfig(): { repos?: string[]; protectedBranches?: string[] } | null {
  try {
    const settingsPath = join(getAgentDir(), "settings.json");
    const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
    return raw?.workTracker ?? null;
  } catch {
    return null;
  }
}

export function loadConfig(): WorkTrackerConfig {
  // 1. Env vars take precedence (CI / shell overrides)
  if (process.env.WORK_TRACKER_REPOS) {
    return {
      guardedRepos: process.env.WORK_TRACKER_REPOS.split(",").map((s) => s.trim()),
      protectedBranches: process.env.WORK_TRACKER_PROTECTED
        ? process.env.WORK_TRACKER_PROTECTED.split(",").map((s) => s.trim())
        : ["main", "master"],
    };
  }

  // 2. settings.json `workTracker` key
  const fromSettings = readSettingsConfig();
  if (fromSettings?.repos?.length) {
    return {
      guardedRepos: fromSettings.repos,
      protectedBranches: fromSettings.protectedBranches ?? ["main", "master"],
    };
  }

  // 3. Fallback: current working directory
  return {
    guardedRepos: [process.cwd()],
    protectedBranches: process.env.WORK_TRACKER_PROTECTED
      ? process.env.WORK_TRACKER_PROTECTED.split(",").map((s) => s.trim())
      : ["main", "master"],
  };
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

/**
 * Repos whose last git query returned a non-zero exit code (e.g. mount
 * unavailable). NOT cleared by invalidateGitCache() — failures persist for
 * the lifetime of the session so we don't spawn git subprocesses against an
 * unavailable mount on every turn. Cleared by resetGitFailureCache() which is
 * called on session_start / session_switch / session_shutdown so each new
 * session gets a fresh attempt.
 */
const gitFailureCache = new Map<string, CachedGitStatus>();

/** Pattern matching bash commands that modify git state. */
const GIT_MUTATING_PATTERN = /\bgit\b.*\b(commit|checkout|switch|merge|rebase|pull|push|reset|stash|add|restore|cherry-pick|branch\s+-[dDmM]|worktree)\b/;

/** Returns true if a bash command could modify git state. */
export function isGitMutating(command: string): boolean {
  return GIT_MUTATING_PATTERN.test(command);
}

/** Clear both the per-turn git status cache and the worktree cache. */
export function invalidateGitCache(): void {
  gitStatusCache.clear();
  worktreeCache.clear();
}

/**
 * Clear the failure cache so previously-unreachable repos are retried.
 * Call on session lifecycle boundaries (start / switch / shutdown).
 */
export function resetGitFailureCache(): void {
  gitFailureCache.clear();
}

// ─── Git status ───────────────────────────────────────────────────────────────

export function getGitStatus(repoPath: string): { branch: string | null; dirty: number } {
  // If this repo failed on a previous turn, don't retry until the session resets.
  const failed = gitFailureCache.get(repoPath);
  if (failed) return failed;

  const cached = gitStatusCache.get(repoPath);
  if (cached) return cached;

  // Run git branch --show-current directly so we can inspect the exit code.
  // getCurrentBranch() collapses non-zero and detached-HEAD into the same null;
  // we need to distinguish "command failed" (mount/repo unavailable) from
  // "detached HEAD" (zero exit, empty stdout) to avoid false failure-cache hits.
  const branchResult = gitSync(repoPath, ["branch", "--show-current"]);
  if (branchResult.status !== 0) {
    // Mount or repo unavailable — remember this so we skip future turns.
    const empty: CachedGitStatus = { branch: null, dirty: 0 };
    gitFailureCache.set(repoPath, empty);
    return empty;
  }

  const status: CachedGitStatus = {
    branch: branchResult.stdout.trim() || null,
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

/**
 * Build the per-repo status segments: worktrees (primary signal) and dirty
 * count (health check). Branch name and protected-branch label are omitted —
 * the primary tree is always on main and always protected, so they're noise.
 *
 * Returns null if the path isn't a git repo or there's nothing to surface
 * (no worktrees and primary tree is clean).
 */
function buildRepoSegments(repoPath: string): { name: string; worktrees: string[]; dirty: number } | null {
  const { branch, dirty } = getGitStatus(repoPath);
  if (!branch) return null; // not a git repo
  const worktrees = getActiveWorktrees(repoPath);
  if (worktrees.length === 0 && dirty === 0) return null; // nothing to surface
  return { name: repoPath.split("/").pop() ?? repoPath, worktrees, dirty };
}

/** Plain-text status line for LLM context injection. */
export function buildStatusLine(config: WorkTrackerConfig): string | null {
  const parts: string[] = [];
  for (const repoPath of config.guardedRepos) {
    const seg = buildRepoSegments(repoPath);
    if (!seg) continue;
    const segments: string[] = [];
    if (seg.worktrees.length > 0) segments.push(`worktrees: ${seg.worktrees.join(", ")}`);
    if (seg.dirty > 0) segments.push(`⚠️ main: ${seg.dirty} uncommitted`);
    parts.push(`${seg.name} ${segments.join(" | ")}`);
  }
  return parts.length > 0 ? `[work-tracker] ${parts.join(" || ")}` : null;
}

/**
 * Themed status line for the TUI widget.
 * Worktrees in accent, dirty warning in warning color.
 */
export function buildStatusLineThemed(config: WorkTrackerConfig, theme: Theme): string | null {
  const parts: string[] = [];
  for (const repoPath of config.guardedRepos) {
    const seg = buildRepoSegments(repoPath);
    if (!seg) continue;
    const segments: string[] = [];
    if (seg.worktrees.length > 0) {
      segments.push(theme.fg("accent", `worktrees: ${seg.worktrees.join(", ")}`));
    }
    if (seg.dirty > 0) {
      segments.push(theme.fg("warning", `⚠️ main: ${seg.dirty} uncommitted`));
    }
    parts.push(`${seg.name} ${segments.join(" | ")}`);
  }
  if (parts.length === 0) return null;
  const label = theme.fg("customMessageLabel", "\x1b[1m[work-tracker]\x1b[22m");
  return `${label} ${parts.join(" || ")}`;
}
