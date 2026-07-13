import { spawnSync } from "node:child_process";

export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

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

export function isGitRepo(cwd: string): boolean {
  return gitSync(cwd, ["rev-parse", "--git-dir"]).status === 0;
}

export function getCurrentBranch(cwd: string): string | null {
  const { status, stdout } = gitSync(cwd, ["branch", "--show-current"]);
  if (status !== 0 || !stdout) return null;
  return stdout.trim() || null;
}

export function getDirtyCount(cwd: string): number {
  const { status, stdout } = gitSync(cwd, ["status", "--porcelain"]);
  if (status !== 0 || !stdout) return 0;
  return stdout.trim().split("\n").filter(Boolean).length;
}

export function getMergedBranches(cwd: string): string[] {
  const { status, stdout } = gitSync(cwd, ["branch", "--merged", "HEAD"]);
  if (status !== 0 || !stdout) return [];
  return stdout
    .split("\n")
    .map((b) => b.replace(/^\*?\s+/, "").trim())
    .filter(Boolean);
}
