/**
 * git.ts — shared git subprocess utilities.
 *
 * Provides a consistent synchronous git invocation primitive (gitSync) and
 * common high-level operations used across multiple extensions.
 *
 * All operations are synchronous — git commands are short-lived and don't
 * benefit from async. Use the timeout parameter for safety.
 *
 * Consumers: orch/git.ts, orch/manager.ts, work-tracker/context.ts,
 *            work-tracker/hooks.ts
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
 */
export function gitSync(
  cwd: string,
  args: string[],
  timeout = 5_000,
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
