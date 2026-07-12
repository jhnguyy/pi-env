import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import {
  applyCleanupPlan,
  buildCleanupPlan,
  CleanupDisposition,
  CleanupTargetKind,
  formatCleanupPlan,
  parseCleanupArgs,
  parseWorktreePorcelain,
} from "../cleanup-core";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function createCleanupFixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-cleanup-test-"));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "--initial-branch=main", repo], { encoding: "utf8" });
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  writeFileSync(join(repo, "README.md"), "initial\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "initial");

  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", origin], { encoding: "utf8" });
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-u", "origin", "main");
  git(repo, "remote", "set-head", "origin", "main");

  git(repo, "branch", "feat/ancestor", "main");

  git(repo, "checkout", "-b", "fix/squashed");
  writeFileSync(join(repo, "squashed.txt"), "local only\n");
  git(repo, "add", "squashed.txt");
  git(repo, "commit", "-m", "local only");
  git(repo, "checkout", "main");

  const dirtyWorktree = join(root, "dirty-worktree");
  git(repo, "worktree", "add", "-b", "feat/dirty", dirtyWorktree, "main");
  writeFileSync(join(dirtyWorktree, "dirty.txt"), "dirty\n");

  return { root, repo, dirtyWorktree };
}

describeIfEnabled("dev-tools", "/cleanup command", () => {
  it("parses dry-run, apply, force, no-fetch, and base args", () => {
    expect(parseCleanupArgs(undefined)).toEqual({ apply: false, force: false, fetch: true, baseRef: undefined, repoPath: undefined });
    expect(parseCleanupArgs("apply --force --no-fetch --base origin/develop --repo /repo")).toEqual({
      apply: true,
      force: true,
      fetch: false,
      baseRef: "origin/develop",
      repoPath: "/repo",
    });
    expect(parseCleanupArgs("--apply --base=upstream/main --repo=/tmp/repo")).toMatchObject({
      apply: true,
      baseRef: "upstream/main",
      repoPath: "/tmp/repo",
    });
    expect(parseCleanupArgs("/mnt/tank/code/pi-env")).toMatchObject({
      apply: false,
      repoPath: "/mnt/tank/code/pi-env",
    });
    expect(parseCleanupArgs("apply /mnt/tank/code/pi-env --no-fetch")).toMatchObject({
      apply: true,
      fetch: false,
      repoPath: "/mnt/tank/code/pi-env",
    });
    expect(parseCleanupArgs("--base origin/develop /mnt/tank/code/pi-env")).toMatchObject({
      baseRef: "origin/develop",
      repoPath: "/mnt/tank/code/pi-env",
    });
  });

  it("parses git worktree porcelain output", () => {
    const worktrees = parseWorktreePorcelain(`worktree /repo\nHEAD aaa\nbranch refs/heads/main\n\nworktree /tmp/repo-feature\nHEAD bbb\nbranch refs/heads/feat/example\n\nworktree /tmp/repo-detached\nHEAD ccc\ndetached\n`);

    expect(worktrees).toEqual([
      { path: "/repo", head: "aaa", branch: "main", detached: false },
      { path: "/tmp/repo-feature", head: "bbb", branch: "feat/example", detached: false },
      { path: "/tmp/repo-detached", head: "ccc", branch: undefined, detached: true },
    ]);
  });

  it("formats safe, force-required, and skipped cleanup targets", () => {
    const plan = {
      repoRoot: "/repo",
      baseRef: "origin/main",
      currentBranch: "main",
      protectedBranches: ["main"],
      warnings: ["fetch failed"],
      targets: [
        {
          kind: CleanupTargetKind.Worktree,
          branch: "feat/done",
          path: "/tmp/repo-feat-done",
          disposition: CleanupDisposition.Safe,
          proof: ["refs/heads/feat/done is ancestor of origin/main"],
        },
        {
          kind: CleanupTargetKind.Branch,
          branch: "fix/squashed",
          disposition: CleanupDisposition.NeedsForce,
          reason: "remote branch is gone, but local commits are not ancestors of the base ref (common after squash merge)",
          proof: ["remote branch is gone after fetch --prune"],
        },
        {
          kind: CleanupTargetKind.Worktree,
          branch: "feat/dirty",
          path: "/tmp/repo-feat-dirty",
          disposition: CleanupDisposition.Skipped,
          reason: "worktree has uncommitted changes",
          proof: [],
        },
      ],
    };

    const text = formatCleanupPlan(plan as Parameters<typeof formatCleanupPlan>[0], false);
    expect(text).toContain("Cleanup plan for /repo");
    expect(text).toContain("Safe:");
    expect(text).toContain("worktree /tmp/repo-feat-done");
    expect(text).toContain("Needs --force:");
    expect(text).toContain("fix/squashed");
    expect(text).toContain("Skipped:");
    expect(text).toContain("feat/dirty");
    expect(text).toContain("Warnings:");
    expect(text).toContain("/cleanup apply");
  });

  it("registers the cleanup command from the dev-tools entrypoint", async () => {
    const mod = await import("../index");
    const registered: Array<{ name: string; opts: { description: string } }> = [];
    const mockPi = {
      registerCommand(name: string, opts: { description: string }) { registered.push({ name, opts }); },
      registerTool: () => {},
      on: () => {},
    };

    mod.default(mockPi as any);

    const command = registered.find((entry) => entry.name === "cleanup");
    expect(command).toBeDefined();
    expect(command!.opts.description).toContain("worktrees");
    expect(command!.opts.description).toContain("fetch --prune");
    expect(command!.opts.description).toContain("/cleanup /path/to/repo");
  });

  it("classifies ancestor, dirty worktree, and remote-gone squash cleanup paths", () => {
    const { repo, dirtyWorktree } = createCleanupFixture();
    const plan = buildCleanupPlan(repo, { apply: false, force: false, fetch: false, baseRef: "origin/main" });

    const ancestor = plan.targets.find((target) => target.branch === "feat/ancestor");
    expect(ancestor?.disposition).toBe(CleanupDisposition.Safe);

    const squashed = plan.targets.find((target) => target.branch === "fix/squashed");
    expect(squashed?.disposition).toBe(CleanupDisposition.NeedsForce);
    expect(squashed?.reason).toContain("squash merge");

    const dirty = plan.targets.find((target) => target.path === dirtyWorktree);
    expect(dirty?.disposition).toBe(CleanupDisposition.Skipped);
    expect(dirty?.reason).toBe("worktree has uncommitted changes");
  });

  it("applies safe cleanup without deleting force-required branches unless force is set", () => {
    const { repo } = createCleanupFixture();
    const safeOnlyPlan = buildCleanupPlan(repo, { apply: true, force: false, fetch: false, baseRef: "origin/main" });

    const safeActions = applyCleanupPlan(safeOnlyPlan, { apply: true, force: false, fetch: false, baseRef: "origin/main" });
    expect(safeActions).toContain("deleted branch feat/ancestor");
    expect(git(repo, "branch", "--list", "feat/ancestor")).toBe("");
    expect(git(repo, "branch", "--list", "fix/squashed")).toContain("fix/squashed");

    const forcePlan = buildCleanupPlan(repo, { apply: true, force: true, fetch: false, baseRef: "origin/main" });
    const forceActions = applyCleanupPlan(forcePlan, { apply: true, force: true, fetch: false, baseRef: "origin/main" });
    expect(forceActions).toContain("deleted branch fix/squashed");
    expect(git(repo, "branch", "--list", "fix/squashed")).toBe("");
  });
});
