/**
 * Git worktree operations for orch.
 *
 * All git I/O lives here. Uses spawnSync — worktree operations are
 * short-lived and don't benefit from async. Errors on create (throw),
 * best-effort on remove (log + continue) to never block cleanup.
 */

import { spawnSync } from "node:child_process";
import { OrchError } from "./types";

// ─── createWorktree ──────────────────────────────────────────

/**
 * Create a new git worktree at worktreePath on a new branch.
 * Branch is created from HEAD of the repo at the time of spawn.
 * Throws OrchError if git exits non-zero.
 */
export function createWorktree(
  repo: string,
  worktreePath: string,
  branch: string,
): void {
  const result = spawnSync(
    "git",
    ["-C", repo, "worktree", "add", worktreePath, "-b", branch],
    { encoding: "utf8", timeout: 15_000 },
  );

  if (result.status !== 0) {
    throw new OrchError(
      `git worktree add failed: ${(result.stderr || result.stdout || "").trim()}`,
      "WORKTREE_CREATE_FAILED",
    );
  }
}

// ─── removeWorktree ──────────────────────────────────────────

/**
 * Remove a worktree. Best-effort: logs on failure, never throws.
 * `--force` handles the case where the worktree has uncommitted changes
 * (branches are preserved regardless — only the directory is removed).
 */
export function removeWorktree(repo: string, worktreePath: string): void {
  const result = spawnSync(
    "git",
    ["-C", repo, "worktree", "remove", worktreePath, "--force"],
    { encoding: "utf8", timeout: 10_000 },
  );

  if (result.status !== 0) {
    console.error(
      `[orch] git worktree remove ${worktreePath} failed (continuing): ${(result.stderr || result.stdout || "").trim()}`,
    );
  }
}

// ─── pruneWorktrees ──────────────────────────────────────────

/**
 * Run `git worktree prune` to clean up stale lockfiles.
 * Called after all removes — best-effort, never throws.
 */
export function pruneWorktrees(repo: string): void {
  spawnSync("git", ["-C", repo, "worktree", "prune"], {
    encoding: "utf8",
    timeout: 5_000,
  });
}
