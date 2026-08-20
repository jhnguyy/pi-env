import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { AgentToolEvent, PiEvent, ToolCapability } from "../../_shared/agent-tools";
import { toAgentTool, toPiTool } from "../../_shared/tool-contract";
import {
  closeoutPullRequest,
  createCloseoutToolContract,
  parseCloseoutArgs,
  type CloseoutRequest,
} from "../closeout";

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
    if (args.join(" ") === "remote get-url origin") {
      return ok("https://github.com/acme/demo.git\n");
    }

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

function githubAlias(call: ExecCall): ExecResult | undefined {
  if (call.command === "git" && call.args.join(" ") === "remote get-url origin") {
    return ok("git@github-agent:acme/demo.git\n");
  }
  if (call.command === "ssh" && call.args.join(" ") === "-G -- github-agent") {
    return ok("host github-agent\nhostname github.com\nuser git\n");
  }
  return undefined;
}

function unrelatedAlias(call: ExecCall): ExecResult | undefined {
  if (call.command === "git" && call.args.join(" ") === "remote get-url origin") {
    return ok("git@notgithub:acme/demo.git\n");
  }
  if (call.command === "ssh" && call.args.join(" ") === "-G -- notgithub") {
    return ok("host notgithub\nhostname git.example.test\nuser git\n");
  }
  return undefined;
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

  it("exposes one host-independent contract through the shared adapters", () => {
    const contract = createCloseoutToolContract(async () => ok());
    const piTool = toPiTool(contract);
    const agentTool = toAgentTool(contract, () => ({ cwd: "/session" }));

    expect(agentTool.name).toBe(piTool.name);
    expect(agentTool.label).toBe(piTool.label);
    expect(agentTool.description).toBe(piTool.description);
    expect(agentTool.parameters).toBe(piTool.parameters);
  });

  it("registers closeout as both a slash command and an authorized LLM tool", async () => {
    const commands: Array<{ name: string; description: string }> = [];
    const tools: Array<{ name: string; description: string; promptGuidelines?: string[] }> = [];
    const { default: initDevTools } = await import("../index");
    initDevTools({
      registerCommand(name: string, options: { description: string }) {
        commands.push({ name, description: options.description });
      },
      registerTool(tool: { name: string; description: string; promptGuidelines?: string[] }) {
        tools.push(tool);
      },
      on() {},
    } as unknown as ExtensionAPI);

    expect(commands).toContainEqual({
      name: "closeout",
      description: expect.stringContaining("merged GitHub pull request"),
    });
    expect(tools).toContainEqual(
      expect.objectContaining({
        name: "closeout",
        description: expect.stringContaining("merged GitHub pull request"),
        promptGuidelines: [expect.stringContaining("explicitly")],
      }),
    );
  });

  it("returns compact text and structured details from the closeout tool", async () => {
    const fixture = createCloseoutFixture();
    const { exec } = createExec(fixture);
    const tools: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
    const { default: initDevTools } = await import("../index");
    initDevTools({
      exec,
      registerCommand() {},
      registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }) {
        tools.push(tool);
      },
      on() {},
    } as unknown as ExtensionAPI);
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

  it("uses the actual session generation in the child factory, preserves capabilities, and propagates cancellation", async () => {
    const registrations: any[] = [];
    const sessionStartHandlers: Array<(...args: any[]) => void> = [];
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
    const { default: initDevTools } = await import("../index");
    initDevTools({
      exec,
      events: {
        emit(event: string, registration: unknown) {
          if (event === AgentToolEvent.Register) registrations.push(registration);
        },
      },
      registerCommand() {},
      registerTool() {},
      on(event: string, handler: (...args: any[]) => void) {
        if (event === PiEvent.SessionStart) sessionStartHandlers.push(handler);
      },
    } as unknown as ExtensionAPI);
    for (const handler of sessionStartHandlers) handler(undefined, { cwd: "/session" });
    const registration = registrations.find(({ tool }) => tool.name === "closeout");
    expect(registration.capabilities).toEqual([
      ToolCapability.Write,
      ToolCapability.Execute,
    ]);
    const tool = registration.createTool({
      cwd: "/child",
      sessionGeneration: registration.sessionGeneration,
    });
    const controller = new AbortController();

    const execution = tool.execute(
      "agent-closeout-call",
      { pr: "42", repo: "repo" },
      controller.signal,
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
    const { exec, calls } = createExec(fixture, {}, githubAlias);

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
    expect(calls).toContainEqual({
      command: "ssh",
      args: ["-G", "--", "github-agent"],
      cwd: fixture.repo,
    });
  });

  it("rejects an SSH host alias that does not resolve to GitHub", async () => {
    const fixture = createCloseoutFixture();
    const { exec, calls } = createExec(fixture, {}, unrelatedAlias);

    await expect(closeoutPullRequest(exec, "/home/agent", request(fixture.repo))).rejects.toThrow(
      "does not belong to the local origin repository",
    );
    expect(hasMutatingGitCall(calls)).toBe(false);
  });

  it.each(["production", "release/2026.08"])(
    "rejects protected head branch %s before running git",
    async (headRefName) => {
      const calls: ExecCall[] = [];
      const exec: ExtensionAPI["exec"] = async (command, args, options) => {
        calls.push({ command, args: [...args], cwd: options?.cwd });
        return ok(
          JSON.stringify({
            state: "MERGED",
            mergedAt: "2026-08-19T12:00:00Z",
            mergeCommit: { oid: "a".repeat(40) },
            url: "https://github.com/acme/demo/pull/42",
            headRefName,
            headRefOid: "b".repeat(40),
            baseRefName: "main",
            isCrossRepository: false,
          }),
        );
      };

      await expect(closeoutPullRequest(exec, "/repo", { pr: "42" })).rejects.toThrow(
        "protected branch",
      );
      expect(calls.filter(({ command }) => command === "git")).toEqual([]);
    },
  );

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
