/**
 * @module _shared/git
 * @purpose Synchronous git subprocess primitives. Use for any git operation in an extension.
 *
 * @example
 *   const { status, stdout } = gitSync("/path/to/repo", ["log", "--oneline", "-5"]);
 *   const branch = getCurrentBranch("/path/to/repo"); // "main" | null
 */

import { spawnSync } from "node:child_process";

// ─── Primitive ────────────────────────────────────────────────────────────────

export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run a git command synchronously in a given directory.
 * Returns raw stdout/stderr and exit status. Never throws.
 *
 * Timeout defaults to 5 000 ms. Override globally with the
 * `WORK_TRACKER_GIT_TIMEOUT` environment variable (milliseconds):
 *
 *   WORK_TRACKER_GIT_TIMEOUT=2000 pi   # recommended for slow/NFS mounts
 *
 * A per-call `timeout` argument takes precedence over the env var.
 */
export function gitSync(
  cwd: string,
  args: string[],
  timeout = Number(process.env.WORK_TRACKER_GIT_TIMEOUT) || 5_000,
): GitResult {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ─── Common operations ────────────────────────────────────────────────────────

/** Returns true if the path is inside a git repository. */
export function isGitRepo(cwd: string): boolean {
  return gitSync(cwd, ["rev-parse", "--git-dir"]).status === 0;
}

/** Returns the current branch name, or null if not on a branch / not a repo. */
export function getCurrentBranch(cwd: string): string | null {
  const { status, stdout } = gitSync(cwd, ["branch", "--show-current"]);
  if (status !== 0 || !stdout) return null;
  return stdout.trim() || null;
}

/** Returns the number of uncommitted changes (staged + unstaged). */
export function getDirtyCount(cwd: string): number {
  const { status, stdout } = gitSync(cwd, ["status", "--porcelain"]);
  if (status !== 0 || !stdout) return 0;
  return stdout.trim().split("\n").filter(Boolean).length;
}

/**
 * Returns all branch names that are merged into HEAD in the given repo.
 * Excludes HEAD itself. Strips the `* ` prefix from the current branch.
 */
export function getMergedBranches(cwd: string): string[] {
  const { status, stdout } = gitSync(cwd, ["branch", "--merged", "HEAD"]);
  if (status !== 0 || !stdout) return [];
  return stdout
    .split("\n")
    .map((b) => b.replace(/^\*?\s+/, "").trim())
    .filter(Boolean);
}
