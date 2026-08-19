import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { closeoutPullRequest, parseCloseoutArgs, type CloseoutRequest } from "../closeout";

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0, killed: false });
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function createCloseoutFixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-closeout-test-"));
  fixtureRoots.push(root);
  const repo = join(root, "repo");
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "--initial-branch=main", repo], { encoding: "utf8" });
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  writeFileSync(join(repo, "README.md"), "initial\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "initial");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", origin], { encoding: "utf8" });
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-u", "origin", "main");
  git(repo, "remote", "set-head", "origin", "main");

  const featureWorktree = join(root, "feature");
  git(repo, "worktree", "add", "-b", "feat/closeout", featureWorktree, "main");
  writeFileSync(join(featureWorktree, "feature.txt"), "feature\n");
  git(featureWorktree, "add", "feature.txt");
  git(featureWorktree, "commit", "-m", "feature");
  git(featureWorktree, "push", "-u", "origin", "feat/closeout");
  const headOid = git(featureWorktree, "rev-parse", "HEAD");

  const unrelatedWorktree = join(root, "unrelated");
  git(repo, "worktree", "add", "-b", "feat/unrelated", unrelatedWorktree, "main");

  const integrator = join(root, "integrator");
  execFileSync("git", ["clone", origin, integrator], { encoding: "utf8" });
  git(integrator, "config", "user.email", "test@example.com");
  git(integrator, "config", "user.name", "Test User");
  git(integrator, "merge", "--squash", "origin/feat/closeout");
  git(integrator, "commit", "-m", "merge feature");
  const mergeOid = git(integrator, "rev-parse", "HEAD");
  git(integrator, "push", "origin", "main");
  git(integrator, "push", "origin", "--delete", "feat/closeout");

  return { repo, featureWorktree, unrelatedWorktree, headOid, mergeOid };
}

type ExecCall = { command: string; args: string[]; cwd?: string };

function createExec(
  fixture: ReturnType<typeof createCloseoutFixture>,
  metadata: Record<string, unknown> = {},
  intercept?: (call: ExecCall) => ExecResult | undefined,
): { exec: ExtensionAPI["exec"]; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const pr = {
    state: "MERGED",
    mergedAt: "2026-08-19T12:00:00Z",
    mergeCommit: { oid: fixture.mergeOid },
    url: "https://github.com/acme/demo/pull/42",
    headRefName: "feat/closeout",
    headRefOid: fixture.headOid,
    baseRefName: "main",
    isCrossRepository: false,
    ...metadata,
  };

  const exec: ExtensionAPI["exec"] = async (command, args, options) => {
    const call = { command, args: [...args], cwd: options?.cwd };
    calls.push(call);
    const intercepted = intercept?.(call);
    if (intercepted) return intercepted;
    if (command === "gh") return ok(JSON.stringify(pr));
    if (command !== "git") throw new Error(`Unexpected command: ${command}`);
    if (args.join(" ") === "remote get-url origin") return ok("git@github.com:acme/demo.git\n");

    const actualArgs = args[0] === "fetch" ? ["fetch", "--prune", "origin"] : args;
    const result = spawnSync("git", actualArgs, {
      cwd: options?.cwd,
      encoding: "utf8",
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      code: result.status ?? 1,
      killed: false,
    };
  };

  return { exec, calls };
}

function hasMutatingGitCall(calls: ExecCall[]): boolean {
  return calls.some(
    ({ command, args }) =>
      command === "git" &&
      (args[0] === "fetch" ||
        args[0] === "merge" ||
        (args[0] === "worktree" && args[1] === "remove") ||
        args[0] === "update-ref"),
  );
}

function request(repoPath: string): CloseoutRequest {
  return { pr: "42", repoPath };
}

describeIfEnabled("dev-tools", "/closeout command", () => {
  it("parses an optional PR reference and repository path", () => {
    expect(parseCloseoutArgs(undefined)).toEqual({ pr: undefined, repoPath: undefined });
    expect(parseCloseoutArgs("42 --repo /repo")).toEqual({ pr: "42", repoPath: "/repo" });
    expect(parseCloseoutArgs("https://github.com/acme/demo/pull/42 --repo=/repo")).toEqual({
      pr: "https://github.com/acme/demo/pull/42",
      repoPath: "/repo",
    });
    expect(() => parseCloseoutArgs("not-a-pr --repo /repo")).toThrow("PR number or GitHub PR URL");
    expect(() => parseCloseoutArgs("41 42 --repo /repo")).toThrow("one PR");
  });

  it("registers one-step closeout from the dev-tools entrypoint", async () => {
    const registered: Array<{ name: string; description: string }> = [];
    const { default: initDevTools } = await import("../index");
    initDevTools({
      registerCommand(name: string, options: { description: string }) {
        registered.push({ name, description: options.description });
      },
      registerTool() {},
      on() {},
    } as unknown as ExtensionAPI);

    expect(registered).toContainEqual({
      name: "closeout",
      description: expect.stringContaining("merged GitHub pull request"),
    });
  });

  it("synchronizes the base and removes only the merged PR head worktree and branch", async () => {
    const fixture = createCloseoutFixture();
    const { exec, calls } = createExec(fixture);

    const result = await closeoutPullRequest(exec, "/home/agent", request(fixture.repo));

    expect(result.prNumber).toBe(42);
    expect(result.baseBranch).toBe("main");
    expect(result.headBranch).toBe("feat/closeout");
    expect(result.removedWorktree).toBe(fixture.featureWorktree);
    expect(result.deletedBranch).toBe(true);
    expect(git(fixture.repo, "branch", "--show-current")).toBe("main");
    expect(git(fixture.repo, "rev-parse", "HEAD")).toBe(fixture.mergeOid);
    expect(existsSync(fixture.featureWorktree)).toBe(false);
    expect(existsSync(fixture.unrelatedWorktree)).toBe(true);
    expect(git(fixture.repo, "branch", "--list", "feat/closeout")).toBe("");
    expect(git(fixture.repo, "branch", "--list", "feat/unrelated")).toContain("feat/unrelated");
    expect(calls.some(({ args }) => args[0] === "checkout" || args[0] === "switch")).toBe(false);
  });

  it("rejects a PR that is not merged before running git", async () => {
    const fixture = createCloseoutFixture();
    const { exec, calls } = createExec(fixture, {
      state: "OPEN",
      mergedAt: null,
      mergeCommit: null,
    });

    await expect(closeoutPullRequest(exec, "/home/agent", request(fixture.repo))).rejects.toThrow(
      "is not merged",
    );
    expect(calls.filter(({ command }) => command === "git")).toEqual([]);
  });

  it("rejects a dirty target worktree before changing refs or worktrees", async () => {
    const fixture = createCloseoutFixture();
    writeFileSync(join(fixture.featureWorktree, "dirty.txt"), "dirty\n");
    const { exec, calls } = createExec(fixture);

    await expect(closeoutPullRequest(exec, "/home/agent", request(fixture.repo))).rejects.toThrow(
      "uncommitted changes",
    );
    expect(hasMutatingGitCall(calls)).toBe(false);
    expect(existsSync(fixture.featureWorktree)).toBe(true);
    expect(git(fixture.repo, "branch", "--list", "feat/closeout")).toContain("feat/closeout");
  });

  it("rejects local head commits that do not match the merged PR", async () => {
    const fixture = createCloseoutFixture();
    writeFileSync(join(fixture.featureWorktree, "extra.txt"), "extra\n");
    git(fixture.featureWorktree, "add", "extra.txt");
    git(fixture.featureWorktree, "commit", "-m", "local extra");
    const { exec, calls } = createExec(fixture);

    await expect(closeoutPullRequest(exec, "/home/agent", request(fixture.repo))).rejects.toThrow(
      "does not match the merged PR head",
    );
    expect(hasMutatingGitCall(calls)).toBe(false);
  });

  it("stops before cleanup when fetch fails", async () => {
    const fixture = createCloseoutFixture();
    const { exec, calls } = createExec(fixture, {}, ({ command, args }) =>
      command === "git" && args[0] === "fetch"
        ? { stdout: "", stderr: "fetch failed", code: 1, killed: false }
        : undefined,
    );

    await expect(closeoutPullRequest(exec, "/home/agent", request(fixture.repo))).rejects.toThrow(
      "fetch failed",
    );
    expect(calls.some(({ args }) => args[0] === "worktree" && args[1] === "remove")).toBe(false);
    expect(calls.some(({ args }) => args[0] === "update-ref")).toBe(false);
    expect(existsSync(fixture.featureWorktree)).toBe(true);
  });

  it("resolves a relative repository path against the Pi working directory", async () => {
    const calls: ExecCall[] = [];
    const exec: ExtensionAPI["exec"] = async (command, args, options) => {
      calls.push({ command, args: [...args], cwd: options?.cwd });
      return ok(
        JSON.stringify({
          state: "OPEN",
          mergedAt: null,
          mergeCommit: null,
          url: "https://github.com/acme/demo/pull/42",
          headRefName: "feat/closeout",
          headRefOid: "a".repeat(40),
          baseRefName: "main",
          isCrossRepository: false,
        }),
      );
    };

    await expect(
      closeoutPullRequest(exec, "/home/agent", { pr: "42", repoPath: "repo" }),
    ).rejects.toThrow("is not merged");
    expect(calls[0]?.cwd).toBe("/home/agent/repo");
  });

  it("rejects fork pull requests before running git", async () => {
    const fixture = createCloseoutFixture();
    const { exec, calls } = createExec(fixture, { isCrossRepository: true });

    await expect(closeoutPullRequest(exec, "/home/agent", request(fixture.repo))).rejects.toThrow(
      "fork pull requests",
    );
    expect(calls.filter(({ command }) => command === "git")).toEqual([]);
  });

  it("does not remove the worktree that contains the Pi current directory through a symlink", async () => {
    const fixture = createCloseoutFixture();
    const linkedCwd = join(fixture.repo, "..", "feature-link");
    symlinkSync(fixture.featureWorktree, linkedCwd);
    const { exec, calls } = createExec(fixture);

    await expect(closeoutPullRequest(exec, linkedCwd, request(fixture.repo))).rejects.toThrow(
      "current Pi working directory",
    );
    expect(hasMutatingGitCall(calls)).toBe(false);
  });

  it("preserves a branch that changes before atomic deletion", async () => {
    const fixture = createCloseoutFixture();
    const { exec } = createExec(fixture, {}, ({ command, args }) => {
      if (command !== "git" || args[0] !== "update-ref" || args[1] !== "-d") return undefined;
      git(fixture.repo, "update-ref", "refs/heads/feat/closeout", fixture.mergeOid);
      return undefined;
    });

    await expect(closeoutPullRequest(exec, "/home/agent", request(fixture.repo))).rejects.toThrow(
      "update-ref",
    );
    expect(git(fixture.repo, "rev-parse", "refs/heads/feat/closeout")).toBe(fixture.mergeOid);
  });
});
