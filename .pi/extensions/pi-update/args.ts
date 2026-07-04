import type { PiUpdateOptions } from "./contract";

export function parseArgs(args: string): PiUpdateOptions {
  const tokens = args.trim().length > 0 ? args.trim().split(/\s+/) : [];
  let version = "latest";
  let repo: string | undefined;
  let worktreeDir: string | undefined;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--repo") {
      repo = tokens[++i];
    } else if (token === "--worktree-dir") {
      worktreeDir = tokens[++i];
    } else if (token === "latest" || !token.startsWith("--")) {
      version = token;
    }
  }

  return { version, repo, worktreeDir };
}
