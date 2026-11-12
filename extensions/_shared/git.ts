import { spawnSync } from "node:child_process";

export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function gitSync(cwd: string, args: string[], timeout = 5_000): GitResult {
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
