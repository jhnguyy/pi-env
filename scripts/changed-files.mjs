import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";

export function changedFiles({ cwd = process.cwd(), base, env = process.env } = {}) {
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const ref = base ?? (env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : "main");
  let mergeBase;
  try {
    mergeBase = git("merge-base", ref, "HEAD").trim();
  } catch {
    throw new Error(
      `Cannot resolve change base ${ref}. Fetch it explicitly or pass --base <ref>; use --full for a source snapshot.`,
    );
  }
  // No rename detection: both the old and new ownership boundaries must be considered.
  const tracked = git("diff", "--name-only", "--no-renames", "-z", mergeBase, "--");
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z");
  const files = [...new Set(`${tracked}\0${untracked}`.split("\0").filter(Boolean))].sort();
  const existing = files.filter((file) => {
    try {
      return statSync(`${cwd}/${file}`).isFile();
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  });
  return { base: mergeBase, files, existing };
}
