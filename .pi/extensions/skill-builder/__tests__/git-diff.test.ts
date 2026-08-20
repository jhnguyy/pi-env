import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { resolveSkillDiff } from "../git-diff";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeSkillDir(): string {
  const root = mkdtempSync(join(tmpdir(), "skill-diff-"));
  roots.push(root);
  const skillDir = join(root, "skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: skill\n---\n");
  return skillDir;
}

it("returns tracked working-tree and index changes against HEAD", async () => {
  const skillDir = makeSkillDir();
  const exec = vi.fn(async () => ({
    code: 0,
    stdout: "diff --git a/SKILL.md b/SKILL.md\n",
    stderr: "",
  }));

  await expect(resolveSkillDiff(exec, skillDir)).resolves.toEqual({
    source: "git-head",
    diff: "diff --git a/SKILL.md b/SKILL.md\n",
  });
  expect(exec).toHaveBeenCalledWith(
    "git",
    ["diff", "HEAD", "--", "SKILL.md"],
    expect.objectContaining({ cwd: skillDir }),
  );
});

it("returns a new-file diff for an untracked SKILL.md", async () => {
  const skillDir = makeSkillDir();
  const exec = vi.fn(async (_command: string, args: string[]) => {
    if (args[0] === "diff" && args[1] === "HEAD") {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "ls-files") {
      return { code: 0, stdout: "SKILL.md\n", stderr: "" };
    }
    return { code: 1, stdout: "diff --git a/dev/null b/SKILL.md\n", stderr: "" };
  });

  await expect(resolveSkillDiff(exec, skillDir)).resolves.toEqual({
    source: "git-head",
    diff: "diff --git a/dev/null b/SKILL.md\n",
  });
  expect(exec).toHaveBeenCalledTimes(3);
  expect(exec.mock.calls[2]?.[1]).toEqual([
    "diff",
    "--no-index",
    "--",
    "/dev/null",
    join(skillDir, "SKILL.md"),
  ]);
});

it.each([
  { condition: "there is no local diff", code: 0, stderr: "", calls: 2 },
  { condition: "the path has no Git HEAD", code: 128, stderr: "fatal", calls: 1 },
])("falls back to the full file when $condition", async ({ code, stderr, calls }) => {
  const skillDir = makeSkillDir();
  const exec = vi.fn(async () => ({ code, stdout: "", stderr }));

  await expect(resolveSkillDiff(exec, skillDir)).resolves.toEqual({ source: "full-file" });
  expect(exec).toHaveBeenCalledTimes(calls);
});

it("passes the abort signal to each Git call", async () => {
  const skillDir = makeSkillDir();
  const controller = new AbortController();
  const signals: Array<AbortSignal | undefined> = [];
  let call = 0;
  const exec = vi.fn(
    async (_command: string, _args: string[], options: { signal?: AbortSignal }) => {
      signals.push(options.signal);
      call += 1;
      if (call === 1) return { code: 0, stdout: "", stderr: "" };
      if (call === 2) return { code: 0, stdout: "SKILL.md\n", stderr: "" };
      return { code: 1, stdout: "diff\n", stderr: "" };
    },
  );

  await resolveSkillDiff(exec, skillDir, controller.signal);
  expect(signals).toEqual([controller.signal, controller.signal, controller.signal]);
});
