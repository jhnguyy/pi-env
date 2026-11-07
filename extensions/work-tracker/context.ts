import type { Theme } from "@earendil-works/pi-coding-agent";

import { readOptionalAgentSettings } from "../_shared/agent-settings";
import { getCurrentBranch as gitGetCurrentBranch, getDirtyCount, gitSync } from "../_shared/git";
import type { WorkTrackerConfig } from "./types";

const DEFAULT_PROTECTED_BRANCHES = ["main", "master"] as const;

function splitEnvList(value: string): string[] {
  return value.split(",").map((entry) => entry.trim());
}

function getProtectedBranchesFromEnv(): string[] | undefined {
  return process.env.WORK_TRACKER_PROTECTED
    ? splitEnvList(process.env.WORK_TRACKER_PROTECTED)
    : undefined;
}

function readSettingsConfig(): { repos?: string[]; protectedBranches?: string[] } | null {
  return readOptionalAgentSettings()?.workTracker ?? null;
}

function getConfigFromEnv(): WorkTrackerConfig | null {
  if (!process.env.WORK_TRACKER_REPOS) return null;
  return {
    guardedRepos: splitEnvList(process.env.WORK_TRACKER_REPOS),
    protectedBranches: getProtectedBranchesFromEnv() ?? [...DEFAULT_PROTECTED_BRANCHES],
  };
}

function getConfigFromSettings(): WorkTrackerConfig | null {
  const settings = readSettingsConfig();
  if (!settings?.repos?.length) return null;
  return {
    guardedRepos: settings.repos,
    protectedBranches: settings.protectedBranches ?? [...DEFAULT_PROTECTED_BRANCHES],
  };
}

function getDefaultConfig(): WorkTrackerConfig {
  return {
    guardedRepos: [process.cwd()],
    protectedBranches: getProtectedBranchesFromEnv() ?? [...DEFAULT_PROTECTED_BRANCHES],
  };
}

export function loadConfig(): WorkTrackerConfig {
  return getConfigFromEnv() ?? getConfigFromSettings() ?? getDefaultConfig();
}

interface CachedGitStatus {
  branch: string | null;
  dirty: number;
}

const gitStatusCache = new Map<string, CachedGitStatus>();

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

const GIT_MUTATING_PATTERN = /\bgit\b.*\b(commit|checkout|switch|merge|rebase|pull|push|reset|stash|add|restore|cherry-pick|branch\s+-[dDmM]|worktree)\b/;

export function isGitMutating(command: string): boolean {
  return GIT_MUTATING_PATTERN.test(command);
}

export function invalidateGitCache(): void {
  gitStatusCache.clear();
  worktreeCache.clear();
}

export function resetGitFailureCache(): void {
  gitFailureCache.clear();
}

export function getGitStatus(repoPath: string): { branch: string | null; dirty: number } {
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

export function getCurrentBranch(): string | null {
  return gitGetCurrentBranch(process.cwd());
}

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

  const blocks = stdout.split(/\n\n+/).filter(Boolean);
  const branches: string[] = [];
  for (const block of blocks.slice(1)) {
    for (const line of block.split("\n")) {
      if (line.startsWith("branch refs/heads/")) {
        branches.push(line.slice("branch refs/heads/".length).trim());
        break;
      }
    }
  }

  worktreeCache.set(repoPath, branches);
  return branches;
}

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
  if (!branch) return null;
  const worktrees = getActiveWorktrees(repoPath);
  if (worktrees.length === 0 && dirty === 0) return null;
  return { name: repoPath.split("/").pop() ?? repoPath, worktrees, dirty };
}

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
