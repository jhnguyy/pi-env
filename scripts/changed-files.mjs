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
      `Cannot resolve change base ${ref}. Fetch it explicitly or pass --base <ref>. For a source snapshot, use nub run verify:full in an environment with adequate capacity.`,
    );
  }
  // No rename detection: both the old and new ownership boundaries must be considered.
  const tracked = git("diff", "--name-only", "--no-renames", "-z", mergeBase, "--");
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z");
  const files = [...new Set(`${tracked}\0${untracked}`.split("\0").filter(Boolean))].sort();
  // Content-only checks judge content the change introduced; an identical rename introduces
  // none. Path-dependent checks still need the destination, so report renames separately.
  const fields = git("diff", "--name-status", "--diff-filter=R", "-M100%", "-z", mergeBase, "--")
    .split("\0")
    .filter(Boolean);
  const renames = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    renames.push({ from: fields[index + 1], to: fields[index + 2] });
  }
  const renamed = new Set(renames.map(({ to }) => to));
  const edited = files.filter((file) => {
    if (renamed.has(file)) return false;
    try {
      return statSync(`${cwd}/${file}`).isFile();
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  });
  return { base: mergeBase, files, edited, renames };
}
