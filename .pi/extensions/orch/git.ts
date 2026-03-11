/**
 * Git worktree operations for orch.
 *
 * All git I/O lives here. Uses spawnSync — worktree operations are
 * short-lived and don't benefit from async. Errors on create (throw),
 * best-effort on remove (log + continue) to never block cleanup.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, symlinkSync } from "node:fs";
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

// ─── prepareWorktree ─────────────────────────────────────────

/**
 * Symlink gitignored node_modules/ directories from the source repo into
 * a freshly-created worktree.
 *
 * Git worktrees only contain tracked files — node_modules/ (gitignored)
 * are absent. Pi loads extensions from {cwd}/.pi/extensions/ and resolves
 * imports relative to each extension's own directory via jiti. Extensions
 * with local deps (e.g. lsp with bash-language-server) fail without this.
 *
 * What we symlink:
 *   - {worktree}/node_modules (top-level project deps)
 *   - {worktree}/.pi/extensions/{ext}/node_modules (per-extension deps)
 *
 * Safe because:
 * - node_modules/ is universally .gitignored — symlinks invisible to git
 * - Workers resolve imports, never run `bun install` — read-only sharing
 * - Cleanup: git worktree remove --force deletes the directory + symlinks;
 *   symlink targets (source repo's node_modules/) are untouched
 *
 * Best-effort: logs on failure, never throws — a missing symlink surfaces
 * as an extension load error rather than silently aborting the spawn.
 */
export function prepareWorktree(repo: string, worktreePath: string): void {
  // 1. Top-level node_modules
  _symlinkIfAbsent(`${repo}/node_modules`, `${worktreePath}/node_modules`);

  // 2. Per-extension node_modules (e.g. lsp/node_modules/bash-language-server)
  const repoExtDir = `${repo}/.pi/extensions`;
  const wtExtDir = `${worktreePath}/.pi/extensions`;
  if (existsSync(repoExtDir) && existsSync(wtExtDir)) {
    for (const entry of readdirSync(wtExtDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      _symlinkIfAbsent(
        `${repoExtDir}/${entry.name}/node_modules`,
        `${wtExtDir}/${entry.name}/node_modules`,
      );
    }
  }
}

function _symlinkIfAbsent(target: string, link: string): void {
  if (!existsSync(target)) return; // nothing to link from
  if (existsSync(link)) return;    // already present
  try {
    symlinkSync(target, link);
  } catch (err) {
    console.error(`[orch] Failed to symlink ${link} → ${target}: ${err}`);
  }
}
