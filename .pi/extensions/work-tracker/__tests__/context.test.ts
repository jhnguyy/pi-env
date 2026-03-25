import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getActiveWorktrees, invalidateGitCache } from "../context";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function git(repo: string, cmd: string): void {
  execSync(`git -C ${repo} ${cmd}`, { stdio: "pipe" });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wt-ctx-test-"));
  git(dir, "init -b main");
  git(dir, 'config user.email "test@test.com"');
  git(dir, 'config user.name "Test"');
  execSync(`touch ${dir}/file.txt`);
  git(dir, "add .");
  git(dir, 'commit -m "init"');
  return dir;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("getActiveWorktrees", () => {
  let repo: string;
  let tmpDirs: string[] = [];

  beforeEach(() => {
    repo = makeRepo();
    tmpDirs = [repo];
    invalidateGitCache();
  });

  afterEach(() => {
    // Remove worktrees before deleting dirs
    try { git(repo, "worktree prune"); } catch {}
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  it("returns empty array when no extra worktrees exist", () => {
    expect(getActiveWorktrees(repo)).toEqual([]);
  });

  it("returns branch name of a single extra worktree", () => {
    const wtDir = mkdtempSync(join(tmpdir(), "wt-extra-"));
    tmpDirs.push(wtDir);
    rmSync(wtDir, { recursive: true, force: true }); // git worktree add creates it
    git(repo, `worktree add -b feat/foo ${wtDir}`);
    invalidateGitCache();

    expect(getActiveWorktrees(repo)).toEqual(["feat/foo"]);
  });

  it("returns all extra worktree branches", () => {
    const wt1 = mkdtempSync(join(tmpdir(), "wt-a-"));
    const wt2 = mkdtempSync(join(tmpdir(), "wt-b-"));
    tmpDirs.push(wt1, wt2);
    rmSync(wt1, { recursive: true, force: true });
    rmSync(wt2, { recursive: true, force: true });
    git(repo, `worktree add -b feat/foo ${wt1}`);
    git(repo, `worktree add -b fix/bar ${wt2}`);
    invalidateGitCache();

    const result = getActiveWorktrees(repo);
    expect(result).toContain("feat/foo");
    expect(result).toContain("fix/bar");
    expect(result.length).toBe(2);
  });

  it("does not include the primary worktree's branch", () => {
    const wt = mkdtempSync(join(tmpdir(), "wt-extra-"));
    tmpDirs.push(wt);
    rmSync(wt, { recursive: true, force: true });
    git(repo, `worktree add -b feat/foo ${wt}`);
    invalidateGitCache();

    expect(getActiveWorktrees(repo)).not.toContain("main");
  });

  it("caches — returns same result on repeated calls without invalidation", () => {
    const wt = mkdtempSync(join(tmpdir(), "wt-extra-"));
    tmpDirs.push(wt);
    rmSync(wt, { recursive: true, force: true });
    git(repo, `worktree add -b feat/foo ${wt}`);
    invalidateGitCache();

    const first = getActiveWorktrees(repo);
    // Remove the worktree without invalidating cache
    git(repo, `worktree remove --force ${wt}`);
    const second = getActiveWorktrees(repo);
    // Cache still returns the stale result
    expect(second).toEqual(first);
  });

  it("re-fetches after invalidateGitCache", () => {
    const wt = mkdtempSync(join(tmpdir(), "wt-extra-"));
    tmpDirs.push(wt);
    rmSync(wt, { recursive: true, force: true });
    git(repo, `worktree add -b feat/foo ${wt}`);
    invalidateGitCache();

    const before = getActiveWorktrees(repo);
    expect(before).toContain("feat/foo");

    git(repo, `worktree remove --force ${wt}`);
    git(repo, "worktree prune");
    invalidateGitCache();

    const after = getActiveWorktrees(repo);
    expect(after).toEqual([]);
  });
});
