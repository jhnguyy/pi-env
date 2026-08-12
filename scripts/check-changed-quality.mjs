#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const run = (command, args, options = {}) =>
  spawnSync(command, args, { cwd: process.cwd(), encoding: "utf8", ...options });
const git = (...args) => run("git", args);
const output = (result) => result.stdout?.trim() ?? "";

if (!existsSync(".git") && git("rev-parse", "--git-dir").status !== 0) {
  console.log("changed-code-quality: skipped because the build has no git metadata");
  process.exit(0);
}

const candidates = [
  process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : undefined,
  "origin/main",
  "main",
].filter(Boolean);
const baseRef = candidates.find((ref) => git("rev-parse", "--verify", ref).status === 0);
if (!baseRef) {
  console.error("changed-code-quality: cannot find the pull request base ref");
  process.exit(1);
}
const mergeBase = git("merge-base", baseRef, "HEAD");
if (mergeBase.status !== 0 || !output(mergeBase)) {
  console.error(`changed-code-quality: cannot compute merge base for ${baseRef}`);
  process.exit(1);
}

for (const [checks, failOn] of [
  ["complexity,duplicates", "warning"],
  ["async-risk", "error"],
]) {
  const result = run(
    "nub",
    [
      "run",
      "analyze",
      "--",
      "--diff",
      "--ref",
      output(mergeBase),
      "--checks",
      checks,
      "--fail-on",
      failOn,
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
