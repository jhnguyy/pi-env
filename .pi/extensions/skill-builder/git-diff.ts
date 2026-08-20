import { join } from "node:path";

export type SkillDiffSource = "git-head" | "full-file";

export type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type ExecFn = (
  command: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal },
) => Promise<ExecResult>;

export interface SkillDiff {
  source: SkillDiffSource;
  diff?: string;
}

export async function resolveSkillDiff(
  exec: ExecFn,
  skillDir: string,
  signal?: AbortSignal,
): Promise<SkillDiff> {
  try {
    const tracked = await exec("git", ["diff", "HEAD", "--", "SKILL.md"], {
      cwd: skillDir,
      signal,
    });
    if (tracked.code !== 0) return { source: "full-file" };
    if (tracked.stdout.trim()) return { source: "git-head", diff: tracked.stdout };

    const untracked = await exec(
      "git",
      ["ls-files", "--others", "--exclude-standard", "--", "SKILL.md"],
      { cwd: skillDir, signal },
    );
    if (untracked.code !== 0 || !untracked.stdout.trim()) return { source: "full-file" };

    const newFile = await exec(
      "git",
      ["diff", "--no-index", "--", "/dev/null", join(skillDir, "SKILL.md")],
      { cwd: skillDir, signal },
    );
    return newFile.code === 1 && newFile.stdout.trim()
      ? { source: "git-head", diff: newFile.stdout }
      : { source: "full-file" };
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return { source: "full-file" };
  }
}
