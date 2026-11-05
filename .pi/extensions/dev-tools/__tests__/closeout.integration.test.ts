import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { closeoutPullRequest, parseCloseoutArgs, type CloseoutRequest } from "../closeout";

const ok = (stdout = ""): ExecResult => ({
  stdout,
  stderr: "",
  code: 0,
  killed: false,
  truncated: false,
});
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

  git(repo, "remote", "set-url", "--push", "origin", origin);
  git(repo, "remote", "set-url", "origin", "https://github.com/acme/demo.git");
  return { repo, origin, featureWorktree, unrelatedWorktree, headOid, mergeOid };
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
    if (command === "ssh") {
      return ok(`hostname ${args.at(-1) === "github-agent" ? "github.com" : "git.example.test"}\n`);
    }
    if (command !== "git") throw new Error(`Unexpected command: ${command}`);

    // Substitute only transport: production owns the fetch options and destination refspec.
    const actualArgs =
      args[0] === "fetch"
        ? args.map((arg) => (arg.startsWith("https://github.com/") ? fixture.origin : arg))
        : args;
    return new Promise<ExecResult>((resolve) => {
      execFile(
        "git",
        actualArgs,
        { cwd: options?.cwd, signal: options?.signal },
        (error, stdout, stderr) => {
          resolve({
            stdout,
            stderr,
            code: error ? Number(error.code) || 1 : 0,
            killed: error?.killed ?? false,
            truncated: error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          });
        },
      );
    });
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

describe("/closeout command", () => {
  it("parses an optional PR reference and repository path", () => {
    expect(parseCloseoutArgs(undefined)).toEqual({ pr: undefined, repoPath: undefined });
    expect(parseCloseoutArgs("42")).toEqual({ pr: "42", repoPath: undefined });
    expect(parseCloseoutArgs("--repo /repo")).toEqual({ pr: undefined, repoPath: "/repo" });
    expect(parseCloseoutArgs("42 --repo /repo")).toEqual({ pr: "42", repoPath: "/repo" });
    expect(parseCloseoutArgs("https://github.com/acme/demo/pull/42 --repo=/repo")).toEqual({
      pr: "https://github.com/acme/demo/pull/42",
      repoPath: "/repo",
    });
    expect(() => parseCloseoutArgs("not-a-pr --repo /repo")).toThrow("PR number or GitHub PR URL");
    expect(() => parseCloseoutArgs("41 42 --repo /repo")).toThrow("one PR");
  });

  it("returns compact text and structured details from the closeout tool", async () => {
    const fixture = createCloseoutFixture();
    const { exec } = createExec(fixture);
    const tools: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
    const { registerDevTools } = await import("../index");
    const registerTool: Parameters<typeof registerDevTools>[0]["registerTool"] = (tool) => {
      tools.push({ name: tool.name, execute: tool.execute });
    };
    registerDevTools({
      exec,
      registerCommand() {},
      registerTool,
    });
    const tool = tools.find(({ name }) => name === "closeout");
    expect(tool).toBeDefined();
    await expect(
      tool!.execute(
        "invalid-closeout-call",
        { pr: "--repo", repo: fixture.repo },
        undefined,
        undefined,
        { cwd: "/home/agent" },
      ),
    ).rejects.toThrow("PR number or GitHub PR URL");

    const result = await tool!.execute(
      "closeout-call",
      { pr: "42", repo: fixture.repo },
      undefined,
      undefined,
      { cwd: "/home/agent" },
    );

    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("Closed out https://github.com/acme/demo/pull/42"),
      },
    ]);
    expect(result.details).toMatchObject({
      prNumber: 42,
      prUrl: "https://github.com/acme/demo/pull/42",
      baseBranch: "main",
      headBranch: "feat/closeout",
      removedWorktree: fixture.featureWorktree,
      deletedBranch: true,
    });
  });

  it("uses native session cwd and propagates cancellation", async () => {
    const tools: any[] = [];
    let started!: () => void;
    const commandStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let commandWasCancelled = false;
    let commandCwd: string | undefined;
    const exec: ExtensionAPI["exec"] = async (_command, _args, options) => {
      commandCwd = options?.cwd;
      return new Promise<ExecResult>((_resolve, reject) => {
        const signal = options?.signal;
        const cancel = () => {
          commandWasCancelled = true;
          reject(new Error("cancelled"));
        };
        if (signal?.aborted) cancel();
        else signal?.addEventListener("abort", cancel, { once: true });
        started();
      });
    };
    const { registerDevTools } = await import("../index");
    registerDevTools({
      exec,
      registerCommand() {},
      registerTool(tool) {
        tools.push(tool);
      },
    });
    const tool = tools.find((tool) => tool.name === "closeout");
    const controller = new AbortController();

    const execution = tool.execute(
      "agent-closeout-call",
      { pr: "42", repo: "repo" },
      controller.signal,
      undefined,
      { cwd: "/child" },
    );
    const rejected = expect(execution).rejects.toThrow();
    await commandStarted;
    controller.abort();

    await rejected;
    expect(commandCwd).toBe("/child/repo");
    expect(commandWasCancelled).toBe(true);
  });

  it("resolves a GitHub SSH host alias before closeout", async () => {
    const fixture = createCloseoutFixture();
    git(fixture.repo, "remote", "set-url", "origin", "git@github-agent:acme/demo.git");
    const { exec, calls } = createExec(fixture);

    const result = await closeoutPullRequest(exec, "/home/agent", request(fixture.repo));
    const persisted = () => ({
      head: git(fixture.repo, "rev-parse", "HEAD"),
      branches: git(fixture.repo, "show-ref", "--heads"),
      worktrees: git(fixture.repo, "worktree", "list", "--porcelain"),
      featureExists: existsSync(fixture.featureWorktree),
      unrelatedExists: existsSync(fixture.unrelatedWorktree),
    });
    const afterFirst = persisted();
    const repeated = await closeoutPullRequest(exec, "/home/agent", request(fixture.repo));
    expect(repeated.deletedBranch).toBe(false);
    expect(repeated.removedWorktree).toBeUndefined();
    expect(persisted()).toEqual(afterFirst);

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
    expect(calls).toContainEqual({
      command: "ssh",
      args: ["-G", "--", "github-agent"],
      cwd: fixture.repo,
    });
  });

  it("fetches GitHub into github refs without pruning or moving mirror origin refs", async () => {
    const fixture = createCloseoutFixture();
    git(fixture.repo, "remote", "set-url", "origin", fixture.origin);
    git(fixture.repo, "remote", "add", "github", "https://github.com/acme/demo.git");
    git(fixture.repo, "update-ref", "refs/remotes/origin/sentinel", fixture.headOid);
    const mirrorRefs = git(fixture.repo, "for-each-ref", "refs/remotes/origin");
    const { exec, calls } = createExec(fixture);

    const result = await closeoutPullRequest(exec, "/home/agent", request(fixture.repo));

    expect(result.deletedBranch).toBe(true);
    expect(existsSync(fixture.featureWorktree)).toBe(false);
    expect(existsSync(fixture.unrelatedWorktree)).toBe(true);
    expect(git(fixture.repo, "rev-parse", "HEAD")).toBe(fixture.mergeOid);
    expect(git(fixture.repo, "rev-parse", "refs/remotes/github/main")).toBe(fixture.mergeOid);
    expect(git(fixture.repo, "for-each-ref", "refs/remotes/origin")).toBe(mirrorRefs);
    expect(calls.find(({ command }) => command === "gh")?.args).toEqual([
      "pr",
      "view",
      "42",
      "--repo",
      "github.com/acme/demo",
      "--json",
      "state,mergedAt,mergeCommit,url,headRefName,headRefOid,baseRefName,isCrossRepository",
    ]);
  });

  it("selects deterministic namespaces for ordinary, SSH, duplicate and URL-disambiguated remotes", async () => {
    const fixture = createCloseoutFixture();
    const scenarios: Array<{ remotes: Record<string, string>; selected: string; pr?: string }> = [
      { remotes: { origin: "https://github.com/acme/demo.git" }, selected: "origin" },
      { remotes: { origin: "ssh://git@github.com/acme/demo.git" }, selected: "origin" },
      {
        remotes: {
          github: "git@github.com:acme/demo.git",
          origin: "https://github.com/ACME/Demo.git",
          aaa: "https://github.com/acme/demo",
        },
        selected: "origin",
      },
      {
        remotes: {
          zzz: "https://github.com/acme/demo",
          github: "https://github.com/acme/demo.git",
          aaa: "git@github.com:acme/demo.git",
        },
        selected: "github",
      },
      {
        remotes: { zzz: "https://github.com/acme/demo", aaa: "git@github.com:acme/demo.git" },
        selected: "aaa",
      },
      {
        remotes: {
          origin: "https://github.com/other/repo.git",
          github: "https://github.com/acme/demo.git",
        },
        selected: "github",
        pr: "https://github.com/acme/demo/pull/42",
      },
    ];
    for (const scenario of scenarios) {
      for (const name of git(fixture.repo, "remote").split("\n").filter(Boolean))
        git(fixture.repo, "remote", "remove", name);
      for (const [name, url] of Object.entries(scenario.remotes))
        git(fixture.repo, "remote", "add", name, url);
      const { exec, calls } = createExec(fixture);
      await closeoutPullRequest(exec, "/home/agent", {
        pr: scenario.pr ?? "42",
        repoPath: fixture.repo,
      });
      expect(calls.find(({ args }) => args[0] === "fetch")?.args).toEqual([
        "fetch",
        "--prune",
        "--no-tags",
        "https://github.com/acme/demo.git",
        `+refs/heads/*:refs/remotes/${scenario.selected}/*`,
      ]);
      expect(git(fixture.repo, "rev-parse", `refs/remotes/${scenario.selected}/main`)).toBe(
        fixture.mergeOid,
      );
      expect(calls.find(({ command }) => command === "gh")?.args.slice(0, 5)).toEqual([
        "pr",
        "view",
        scenario.pr ?? "42",
        "--repo",
        "github.com/acme/demo",
      ]);
    }
  });

  it("fails discovery and ambiguous selection before lookup or mutation", async () => {
    const fixture = createCloseoutFixture();
    const assertRejected = async (
      message: string,
      pr: string | null = "42",
      intercept?: (call: ExecCall) => ExecResult | undefined,
    ) => {
      const before = git(fixture.repo, "show-ref");
      const { exec, calls } = createExec(fixture, {}, intercept);
      await expect(
        closeoutPullRequest(exec, "/home/agent", { pr: pr ?? undefined, repoPath: fixture.repo }),
      ).rejects.toThrow(message);
      expect(calls.some(({ command }) => command === "gh")).toBe(false);
      expect(hasMutatingGitCall(calls)).toBe(false);
      expect(git(fixture.repo, "show-ref")).toBe(before);
      expect(existsSync(fixture.featureWorktree)).toBe(true);
    };
    git(fixture.repo, "remote", "add", "github", "https://github.com/other/repo.git");
    await assertRejected("Pass an explicit GitHub PR URL");
    await assertRejected("Pass an explicit GitHub PR URL", null);
    await assertRejected(
      "No configured GitHub fetch remote matches",
      "https://github.com/missing/repo/pull/42",
    );
    git(fixture.repo, "remote", "remove", "github");
    git(fixture.repo, "config", "--add", "remote.origin.url", "git@github.com:acme/demo.git");
    await assertRejected("multiple distinct effective fetch URLs");
    git(fixture.repo, "config", "--unset-all", "remote.origin.url");
    git(fixture.repo, "config", "--add", "remote.origin.url", "https://github.com/acme/demo.git");
    git(fixture.repo, "config", "--add", "remote.origin.url", fixture.origin);
    await assertRejected(
      "multiple distinct effective fetch URLs",
      "https://github.com/acme/demo/pull/42",
    );
    git(fixture.repo, "config", "--unset-all", "remote.origin.url");
    git(fixture.repo, "config", "--add", "remote.origin.url", "https://github.com/acme/demo.git");
    for (const failedCommand of ["remote", "remote get-url --all origin"]) {
      await assertRejected("discovery failed", "42", ({ command, args }) =>
        command === "git" && args.join(" ") === failedCommand
          ? { ...ok(), code: 1, stderr: "discovery failed" }
          : undefined,
      );
    }
    await assertRejected("invalid tracking namespace", "42", ({ command, args }) =>
      command === "git" && args[0] === "check-ref-format" ? { ...ok(), code: 1 } : undefined,
    );
    git(fixture.repo, "remote", "set-url", "origin", fixture.origin);
    await assertRejected("No configured GitHub fetch remote found");
    git(fixture.repo, "remote", "set-url", "origin", "https://github.com/acme/demo.git");
    git(fixture.repo, "config", "--add", "remote.origin.url", "https://github.com/acme/demo.git");
    const { exec } = createExec(fixture);
    expect(
      (await closeoutPullRequest(exec, "/home/agent", request(fixture.repo))).deletedBranch,
    ).toBe(true);
  });

  it("binds omitted lookup to the current worktree branch and rejects detached HEAD", async () => {
    const fixture = createCloseoutFixture();
    const { exec, calls } = createExec(fixture, { state: "OPEN" });
    await expect(
      closeoutPullRequest(exec, "/home/agent", { repoPath: fixture.featureWorktree }),
    ).rejects.toThrow("is not merged");
    expect(calls.find(({ command }) => command === "gh")?.args.slice(0, 5)).toEqual([
      "pr",
      "view",
      "feat/closeout",
      "--repo",
      "github.com/acme/demo",
    ]);
    expect(hasMutatingGitCall(calls)).toBe(false);
    git(fixture.featureWorktree, "checkout", "--detach");
    const detached = createExec(fixture);
    await expect(
      closeoutPullRequest(detached.exec, "/home/agent", { repoPath: fixture.featureWorktree }),
    ).rejects.toThrow("detached checkout");
    expect(detached.calls.some(({ command }) => command === "gh")).toBe(false);
    expect(hasMutatingGitCall(detached.calls)).toBe(false);
  });

  it("waits for an existing Git index lock before completing cleanup", async () => {
    const fixture = createCloseoutFixture();
    const indexLock = join(fixture.repo, ".git", "index.lock");
    let attempts = 0;
    const { exec } = createExec(fixture, {}, ({ command, args }) => {
      if (command === "git" && args[0] === "merge") {
        attempts += 1;
        if (attempts === 1) {
          writeFileSync(indexLock, "another Git process owns this lock\n");
        } else if (attempts === 2) {
          rmSync(indexLock);
        }
      }
      return undefined;
    });

    try {
      const result = await closeoutPullRequest(exec, "/home/agent", request(fixture.repo));
      expect(attempts).toBe(2);
      expect(result.deletedBranch).toBe(true);
      expect(git(fixture.repo, "rev-parse", "HEAD")).toBe(fixture.mergeOid);
      expect(existsSync(fixture.featureWorktree)).toBe(false);
    } finally {
      rmSync(indexLock, { force: true });
    }
  });

  it("cancels an index-lock wait without removing Git's lock and releases the closeout lock", async () => {
    const fixture = createCloseoutFixture();
    const indexLock = join(fixture.repo, ".git", "index.lock");
    writeFileSync(indexLock, "another Git process owns this lock\n");
    const real = createExec(fixture);
    let merged!: () => void;
    const mergeAttempted = new Promise<void>((resolve) => {
      merged = resolve;
    });
    const exec: ExtensionAPI["exec"] = async (command, args, options) => {
      const result = await real.exec(command, args, options);
      if (command === "git" && args[0] === "merge") merged();
      return result;
    };
    const controller = new AbortController();
    const pending = closeoutPullRequest(
      exec,
      "/home/agent",
      request(fixture.repo),
      controller.signal,
    );
    const rejected = expect(pending).rejects.toThrow();
    await mergeAttempted;
    controller.abort();
    await rejected;

    expect(existsSync(indexLock)).toBe(true);
    expect(existsSync(join(fixture.repo, ".git", "pi-closeout.lock"))).toBe(false);
    expect(existsSync(fixture.featureWorktree)).toBe(true);
    rmSync(indexLock);
    expect(
      (await closeoutPullRequest(real.exec, "/home/agent", request(fixture.repo))).deletedBranch,
    ).toBe(true);
  });

  it("does not retry unrelated merge failures and releases the closeout lock", async () => {
    const fixture = createCloseoutFixture();
    const { exec, calls } = createExec(fixture, {}, ({ command, args }) =>
      command === "git" && args[0] === "merge"
        ? {
            stdout: "",
            stderr: "fatal: unrelated merge failure",
            code: 1,
            killed: false,
            truncated: false,
          }
        : undefined,
    );
    await expect(closeoutPullRequest(exec, "/home/agent", request(fixture.repo))).rejects.toThrow(
      "unrelated merge failure",
    );
    expect(calls.filter(({ args }) => args[0] === "merge")).toHaveLength(1);
    expect(existsSync(join(fixture.repo, ".git", "pi-closeout.lock"))).toBe(false);
    expect(existsSync(fixture.featureWorktree)).toBe(true);
  });

  it("closes different PRs concurrently through worktrees of the same repository", async () => {
    const fixture = createCloseoutFixture();
    writeFileSync(join(fixture.unrelatedWorktree, "second.txt"), "second\n");
    git(fixture.unrelatedWorktree, "add", "second.txt");
    git(fixture.unrelatedWorktree, "commit", "-m", "second feature");
    const secondHead = git(fixture.unrelatedWorktree, "rev-parse", "HEAD");
    git(fixture.unrelatedWorktree, "push", "origin", "feat/unrelated");
    const integrator = join(fixture.repo, "..", "integrator");
    git(integrator, "fetch", "origin");
    git(integrator, "merge", "--squash", "origin/feat/unrelated");
    git(integrator, "commit", "-m", "merge second feature");
    git(integrator, "push", "origin", "main");
    const expectedBase = git(integrator, "rev-parse", "HEAD");
    const first = createExec(fixture);
    const second = createExec(fixture, {
      url: "https://github.com/acme/demo/pull/43",
      headRefName: "feat/unrelated",
      headRefOid: secondHead,
      mergeCommit: { oid: expectedBase },
    });

    let atMerge!: () => void;
    const firstAtMerge = new Promise<void>((resolve) => {
      atMerge = resolve;
    });
    let resumeMerge!: () => void;
    const mergeAllowed = new Promise<void>((resolve) => {
      resumeMerge = resolve;
    });
    let secondFoundRepository!: () => void;
    const secondReady = new Promise<void>((resolve) => {
      secondFoundRepository = resolve;
    });
    let firstFinished = false;
    let overlappingWorkflow = false;
    const firstExec: ExtensionAPI["exec"] = async (command, args, options) => {
      if (command === "git" && args[0] === "merge") {
        atMerge();
        await mergeAllowed;
      }
      return first.exec(command, args, options);
    };
    const secondExec: ExtensionAPI["exec"] = async (command, args, options) => {
      if (command === "git" && args[0] === "worktree" && !firstFinished) overlappingWorkflow = true;
      const result = await second.exec(command, args, options);
      if (args.includes("--git-common-dir")) secondFoundRepository();
      return result;
    };
    const firstPending = closeoutPullRequest(
      firstExec,
      "/home/agent",
      request(fixture.repo),
    ).finally(() => {
      firstFinished = true;
    });
    await firstAtMerge;
    const secondPending = closeoutPullRequest(secondExec, "/home/agent", {
      pr: "43",
      repoPath: fixture.unrelatedWorktree,
    });
    await secondReady;
    resumeMerge();
    const results = await Promise.allSettled([firstPending, secondPending]);

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(overlappingWorkflow).toBe(false);
    expect(git(fixture.repo, "rev-parse", "HEAD")).toBe(expectedBase);
    expect(existsSync(fixture.featureWorktree)).toBe(false);
    expect(existsSync(fixture.unrelatedWorktree)).toBe(false);
    expect(git(fixture.repo, "branch", "--list", "feat/*")).toBe("");
  });

  it("rejects an SSH host alias that does not resolve to GitHub", async () => {
    const fixture = createCloseoutFixture();
    git(fixture.repo, "remote", "set-url", "origin", "git@notgithub:acme/demo.git");
    const { exec, calls } = createExec(fixture);

    await expect(closeoutPullRequest(exec, "/home/agent", request(fixture.repo))).rejects.toThrow(
      "No configured GitHub fetch remote",
    );
    expect(hasMutatingGitCall(calls)).toBe(false);
  });

  it("rejects unsafe or mismatched PR metadata without mutation", async () => {
    const fixture = createCloseoutFixture();
    const before = git(fixture.repo, "show-ref");
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ headRefName: "production" }, "protected branch"],
      [{ headRefName: "release/2026.08" }, "protected branch"],
      [{ state: "OPEN", mergedAt: null, mergeCommit: null }, "is not merged"],
      [{ isCrossRepository: true }, "fork pull requests"],
      [{ url: "https://github.com/other/repo/pull/42" }, "outside the selected repository"],
      [{ url: "https://github.com/acme/demo/pull/43" }, "different pull request"],
      [{ url: "not-a-url" }, "invalid pull request URL"],
    ];
    for (const [metadata, message] of cases) {
      const { exec, calls } = createExec(fixture, metadata);
      await expect(closeoutPullRequest(exec, "/home/agent", request(fixture.repo))).rejects.toThrow(
        message,
      );
      expect(hasMutatingGitCall(calls)).toBe(false);
      expect(git(fixture.repo, "show-ref")).toBe(before);
      expect(existsSync(fixture.featureWorktree)).toBe(true);
    }
    for (const pr of ["https://github.com/acme/demo/pull/42", undefined]) {
      const { exec, calls } = createExec(fixture, { url: "https://github.com/other/repo/pull/42" });
      await expect(
        closeoutPullRequest(exec, "/home/agent", { pr, repoPath: fixture.repo }),
      ).rejects.toThrow("outside the selected repository");
      expect(hasMutatingGitCall(calls)).toBe(false);
    }
    const wrongNumber = createExec(fixture, { url: "https://github.com/acme/demo/pull/43" });
    await expect(
      closeoutPullRequest(wrongNumber.exec, "/home/agent", {
        pr: "https://github.com/acme/demo/pull/42",
        repoPath: fixture.repo,
      }),
    ).rejects.toThrow("different pull request");
    expect(hasMutatingGitCall(wrongNumber.calls)).toBe(false);
    expect(git(fixture.repo, "show-ref")).toBe(before);
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
        ? { stdout: "", stderr: "fetch failed", code: 1, killed: false, truncated: false }
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
    const fixture = createCloseoutFixture();
    const { exec, calls } = createExec(fixture, { state: "OPEN" });
    await expect(
      closeoutPullRequest(exec, join(fixture.repo, ".."), { pr: "42", repoPath: "repo" }),
    ).rejects.toThrow("is not merged");
    expect(calls[0]?.cwd).toBe(fixture.repo);
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
