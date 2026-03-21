import { describe, it, expect, beforeEach } from "bun:test";
import { BranchGuard } from "../branch-guard";
import type { WorkTrackerConfig } from "../types";

const config: WorkTrackerConfig = {
  guardedRepos: [], // No runtime repo checks in unit tests
  protectedBranches: ["main", "master"],
};

describe("BranchGuard", () => {
  let guard: BranchGuard;
  beforeEach(() => {
    guard = new BranchGuard(config);
  });

  // ─── Explicit pushes to protected branch ────────────────────────

  describe("blocks explicit push to protected branch", () => {
    it("git push origin main", () => {
      const r = guard.check("git push origin main");
      expect(r.shouldBlock).toBe(true);
      expect(r.targetBranch).toBe("main");
    });

    it("git push origin master", () => {
      const r = guard.check("git push origin master");
      expect(r.shouldBlock).toBe(true);
      expect(r.targetBranch).toBe("master");
    });

    it("git push --force origin main", () => {
      expect(guard.check("git push --force origin main").shouldBlock).toBe(true);
    });

    it("git push -f origin main", () => {
      expect(guard.check("git push -f origin main").shouldBlock).toBe(true);
    });

    it("force-push shorthand: git push origin +main", () => {
      expect(guard.check("git push origin +main").shouldBlock).toBe(true);
    });

    it("refspec dst: git push origin HEAD:main", () => {
      const r = guard.check("git push origin HEAD:main");
      expect(r.shouldBlock).toBe(true);
      expect(r.targetBranch).toBe("main");
    });

    it("refspec dst: git push origin refs/heads/feat:main", () => {
      expect(guard.check("git push origin refs/heads/feat:main").shouldBlock).toBe(true);
    });
  });

  // ─── Reason text quality ────────────────────────────────────────

  it("reason includes the blocked branch name", () => {
    const r = guard.check("git push origin main");
    expect(r.reason).toContain("`main`");
  });

  it("reason suggests a worktree workflow", () => {
    const r = guard.check("git push origin main");
    expect(r.reason).toContain("git worktree add");
    expect(r.reason).toContain("git push -u origin feat/<name>");
  });

  // ─── Allowed commands ───────────────────────────────────────────

  describe("allows push to non-protected branches", () => {
    it("git push origin feat/my-feature", () => {
      expect(guard.check("git push origin feat/my-feature").shouldBlock).toBe(false);
    });

    it("git push -u origin feat/work-tracker", () => {
      expect(guard.check("git push -u origin feat/work-tracker").shouldBlock).toBe(false);
    });

    it("git push origin chore/docs", () => {
      expect(guard.check("git push origin chore/docs").shouldBlock).toBe(false);
    });

    it("git push origin fix/null-check", () => {
      expect(guard.check("git push origin fix/null-check").shouldBlock).toBe(false);
    });
  });

  describe("allows non-push git commands", () => {
    it("git commit -m 'feat: add thing'", () => {
      expect(guard.check("git commit -m 'feat: add thing'").shouldBlock).toBe(false);
    });

    it("git pull origin main", () => {
      expect(guard.check("git pull origin main").shouldBlock).toBe(false);
    });

    it("git fetch origin", () => {
      expect(guard.check("git fetch origin").shouldBlock).toBe(false);
    });

    it("git merge --no-ff feat/x", () => {
      expect(guard.check("git merge --no-ff feat/x").shouldBlock).toBe(false);
    });
  });

  describe("allows non-git commands", () => {
    it("ls -la", () => {
      expect(guard.check("ls -la").shouldBlock).toBe(false);
    });

    it("npm run test", () => {
      expect(guard.check("npm run test").shouldBlock).toBe(false);
    });
  });

  // ─── Branch name edge cases ──────────────────────────────────────

  describe("does not false-positive on similar branch names", () => {
    it("does not block push to 'maintain'", () => {
      expect(guard.check("git push origin maintain").shouldBlock).toBe(false);
    });

    it("does not block push to 'feat/maintain-state'", () => {
      expect(guard.check("git push origin feat/maintain-state").shouldBlock).toBe(false);
    });

    it("does not block push to 'dev-main-refactor'", () => {
      // "main" is a substring but not a standalone token
      expect(guard.check("git push origin dev-main-refactor").shouldBlock).toBe(false);
    });

    it("does not block push to 'masterclass'", () => {
      expect(guard.check("git push origin masterclass").shouldBlock).toBe(false);
    });
  });

  // ─── Repo-scoped guard (-C flag) ────────────────────────────────

  describe("repo-scoped guard via -C flag", () => {
    const guardedConfig: WorkTrackerConfig = {
      guardedRepos: ["/tank/code/pi-env"],
      protectedBranches: ["main", "master"],
    };

    it("blocks push to main in a guarded repo", () => {
      const g = new BranchGuard(guardedConfig);
      const r = g.check("git -C /tank/code/pi-env push origin main");
      expect(r.shouldBlock).toBe(true);
      expect(r.targetBranch).toBe("main");
    });

    it("allows push to main in an unguarded repo", () => {
      const g = new BranchGuard(guardedConfig);
      const r = g.check("git -C /tank/code/credential-proxy push -u origin main");
      expect(r.shouldBlock).toBe(false);
    });

    it("blocks push to main with no -C (conservative, repo unknown)", () => {
      const g = new BranchGuard(guardedConfig);
      const r = g.check("git push origin main");
      expect(r.shouldBlock).toBe(true);
    });
  });

  // ─── Checkout guard (worktree enforcement) ──────────────────────

  describe("checkout guard", () => {
    it("blocks git checkout -b in guarded repo", () => {
      const r = guard.check("git checkout -b feat/new-tool");
      expect(r.shouldBlock).toBe(true);
      expect(r.reason).toContain("worktree");
    });

    it("blocks git switch -c in guarded repo", () => {
      const r = guard.check("git switch -c fix/bug");
      expect(r.shouldBlock).toBe(true);
      expect(r.reason).toContain("worktree");
    });

    it("blocks git switch -C (force create)", () => {
      const r = guard.check("git switch -C feat/reset");
      expect(r.shouldBlock).toBe(true);
    });

    it("includes branch name in worktree suggestion", () => {
      const r = guard.check("git checkout -b feat/my-feature");
      expect(r.shouldBlock).toBe(true);
      expect(r.reason).toContain("feat/my-feature");
    });

    it("derives worktree path from guarded repo name, not hardcoded", () => {
      const g = new BranchGuard({
        guardedRepos: ["/some/path/myrepo"],
        protectedBranches: ["main"],
      });
      const r = g.check("git checkout -b feat/thing");
      expect(r.shouldBlock).toBe(true);
      expect(r.reason).toContain("myrepo");
      expect(r.reason).not.toContain("/some/path");
    });

    it("allows checkout without -b (switching existing branches)", () => {
      const r = guard.check("git checkout main");
      expect(r.shouldBlock).toBe(false);
    });

    it("allows checkout of files", () => {
      const r = guard.check("git checkout -- src/index.ts");
      expect(r.shouldBlock).toBe(false);
    });

    it("allows git checkout -b in unguarded repo via -C", () => {
      const guardedConfig: WorkTrackerConfig = {
        guardedRepos: ["/tank/code/pi-env"],
        protectedBranches: ["main"],
      };
      const g = new BranchGuard(guardedConfig);
      const r = g.check("git -C /tank/code/credential-proxy checkout -b feat/new");
      expect(r.shouldBlock).toBe(false);
    });
  });
});
