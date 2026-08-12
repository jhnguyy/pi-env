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

const githubBase = process.env.GITHUB_BASE_REF;
if (githubBase && git("rev-parse", "--verify", `origin/${githubBase}`).status !== 0) {
  const fetched = git(
    "fetch",
    "--no-tags",
    "origin",
    `refs/heads/${githubBase}:refs/remotes/origin/${githubBase}`,
  );
  if (fetched.status !== 0) {
    console.error(`changed-code-quality: cannot fetch pull request base ${githubBase}`);
    process.exit(1);
  }
}
const candidates = [githubBase ? `origin/${githubBase}` : undefined, "origin/main", "main"].filter(
  Boolean,
);
if (
  !githubBase &&
  !process.env.GITHUB_ACTIONS &&
  candidates.every((ref) => git("rev-parse", "--verify", ref).status !== 0)
) {
  console.log("changed-code-quality: skipped because the packaged build has no base ref");
  process.exit(0);
}
const baseRef = candidates.find((ref) => git("rev-parse", "--verify", ref).status === 0);
if (!baseRef) {
  console.error("changed-code-quality: cannot find the pull request base ref");
  process.exit(1);
}
const mergeBase = git("merge-base", baseRef, "HEAD");
if (mergeBase.status !== 0 || !output(mergeBase)) {
  const deepened = git(
    "fetch",
    "--no-tags",
    "--deepen=100",
    "origin",
    process.env.GITHUB_BASE_REF ?? "main",
  );
  if (deepened.status === 0) {
    const retry = git("merge-base", baseRef, "HEAD");
    if (retry.status === 0 && output(retry)) {
      mergeBase.stdout = retry.stdout;
      mergeBase.status = retry.status;
    }
  }
}
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
