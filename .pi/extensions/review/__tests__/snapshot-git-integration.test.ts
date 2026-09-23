import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveNodeCommand } from "../../../../src/process/platform.js";
import {
  managedGitExec,
  prepareResolvedSnapshot,
  removeManagedGitWorktreeEffect,
  reviewGitExec,
} from "../snapshot";

const mocked = { agentDir: "" };

const temps: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temps.push(path);
  return path;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fixture() {
  mocked.agentDir = temp("pi-review-agent-");
  const source = temp("pi-review-source-");
  const origin = temp("pi-review-origin-");
  git(source, "init", "-q", "-b", "trunk");
  git(source, "config", "user.name", "Review Fixture");
  git(source, "config", "user.email", "review@example.invalid");
  writeFileSync(join(source, "shared.txt"), "shared\n");
  git(source, "add", ".");
  git(source, "commit", "-qm", "common");
  const commonOid = git(source, "rev-parse", "HEAD");
  writeFileSync(join(source, "base.txt"), "base\n");
  git(source, "add", ".");
  git(source, "commit", "-qm", "base");
  const baseOid = git(source, "rev-parse", "HEAD");
  git(source, "switch", "-qc", "feature", commonOid);
  writeFileSync(join(source, "head.txt"), "head\n");
  git(source, "add", ".");
  git(source, "commit", "-qm", "head");
  const headOid = git(source, "rev-parse", "HEAD");
  git(origin, "init", "-q", "--bare");
  git(source, "remote", "add", "fixture", `file://${origin}`);
  git(source, "push", "-q", "fixture", `${baseOid}:refs/heads/trunk`);
  git(source, "push", "-q", "fixture", `${headOid}:refs/pull/7/head`);

  const metadata = {
    owner: "acme",
    repo: "widgets",
    number: 7,
    url: "https://github.com/acme/widgets/pull/7",
    baseRef: "trunk",
    baseOid,
    headOid,
    changedFiles: [],
  };
  const localExec: ExtensionAPI["exec"] = async (command, rawArgs, options = {}) => {
    const args = [...rawArgs];
    if (command === "git" && args[0] === "remote" && ["add", "set-url"].includes(args[1] ?? ""))
      args[args.length - 1] = `file://${origin}`;
    try {
      const stdout = execFileSync(command, args, {
        cwd: options.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, stdout, stderr: "", killed: false };
    } catch (cause: any) {
      return {
        code: cause.status ?? 1,
        stdout: String(cause.stdout ?? ""),
        stderr: String(cause.stderr ?? cause.message ?? ""),
        killed: false,
      };
    }
  };
  return { commonOid, metadata, localExec, origin };
}

describe("review snapshot Git integration", () => {
  it.skipIf(process.platform === "win32")(
    "terminates the complete command process group on cancellation",
    async () => {
      const root = temp("pi-review-process-");
      const script = join(root, "git-process.mjs");
      const parentPidPath = join(root, "parent.pid");
      const childPidPath = join(root, "child.pid");
      const node = resolveNodeCommand();
      const childCode = `require("node:fs").writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid)); setInterval(() => {}, 1000);`;
      writeFileSync(
        script,
        `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs";\n` +
          `spawn(${JSON.stringify(resolveNodeCommand())}, ["-e", ${JSON.stringify(childCode)}], { stdio: "ignore" });\n` +
          `writeFileSync(${JSON.stringify(parentPidPath)}, String(process.pid));\n` +
          `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);\n`,
      );
      const controller = new AbortController();
      const running = managedGitExec(node, [script], {
        cwd: root,
        signal: controller.signal,
        timeout: 10_000,
      });
      await vi.waitFor(
        () => {
          expect(existsSync(parentPidPath)).toBe(true);
          expect(existsSync(childPidPath)).toBe(true);
        },
        { timeout: 3_000 },
      );
      const parentPid = Number(readFileSync(parentPidPath, "utf8"));
      const childPid = Number(readFileSync(childPidPath, "utf8"));

      controller.abort();
      await expect(running).rejects.toBeDefined();
      await vi.waitFor(() => {
        expect(processIsAlive(parentPid)).toBe(false);
        expect(processIsAlive(childPid)).toBe(false);
      });
    },
    10_000,
  );

  it.skipIf(process.platform === "win32")(
    "waits for a Git process tree to stop before cancelled snapshot preparation settles",
    async () => {
      const root = temp("pi-review-git-cancel-");
      mocked.agentDir = temp("pi-review-agent-");
      const fakeGit = join(root, "git");
      const parentPidPath = join(root, "parent.pid");
      const childPidPath = join(root, "child.pid");
      const node = resolveNodeCommand();
      const childCode = `require("node:fs").writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid)); setInterval(() => {}, 1000);`;
      writeFileSync(
        fakeGit,
        `#!${node}\n` +
          `const { spawn } = require("node:child_process"); const { writeFileSync } = require("node:fs");\n` +
          `spawn(${JSON.stringify(node)}, ["-e", ${JSON.stringify(childCode)}], { stdio: "ignore" });\n` +
          `writeFileSync(${JSON.stringify(parentPidPath)}, String(process.pid));\n` +
          `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);\n`,
      );
      chmodSync(fakeGit, 0o700);
      vi.stubEnv("PATH", `${root}:${process.env.PATH ?? ""}`);
      const controller = new AbortController();
      const metadata = {
        owner: "acme",
        repo: "widgets",
        number: 7,
        url: "https://github.com/acme/widgets/pull/7",
        baseRef: "trunk",
        baseOid: "base",
        headOid: "head",
        changedFiles: [],
      };
      const running = prepareResolvedSnapshot(
        async () => {
          throw new Error("Pi exec must not run Git");
        },
        root,
        metadata,
        controller.signal,
        undefined,
        mocked.agentDir,
        reviewGitExec,
      );
      await vi.waitFor(
        () => {
          expect(existsSync(parentPidPath)).toBe(true);
          expect(existsSync(childPidPath)).toBe(true);
        },
        { timeout: 3_000 },
      );
      const parentPid = Number(readFileSync(parentPidPath, "utf8"));
      const childPid = Number(readFileSync(childPidPath, "utf8"));
      controller.abort();
      await expect(running).rejects.toBeDefined();
      expect(processIsAlive(parentPid)).toBe(false);
      expect(processIsAlive(childPid)).toBe(false);
    },
    10_000,
  );

  it("prepares a fresh snapshot for divergent base and head histories", async () => {
    const f = fixture();
    const snapshot = await prepareResolvedSnapshot(
      f.localExec,
      mocked.agentDir,
      f.metadata,
      undefined,
      undefined,
      mocked.agentDir,
    );
    expect(snapshot.metadata.changedFiles).toEqual([{ path: "head.txt" }]);
    expect(existsSync(snapshot.diffPath)).toBe(true);
    expect(git(snapshot.cache!.repoDir, "merge-base", f.metadata.baseOid, f.metadata.headOid)).toBe(
      f.commonOid,
    );
  });

  it("recovers a failed local-Git snapshot with the same identity and retains evidence", async () => {
    const f = fixture();
    const reviewId = "retry-evidence";
    const artifactRoot = process.env.PI_ENV_REVIEW_E2E_ARTIFACT_DIR
      ? join(process.env.PI_ENV_REVIEW_E2E_ARTIFACT_DIR, `snapshot-${Date.now()}`)
      : mkdtempSync(join(tmpdir(), "pi-review-snapshot-evidence-"));
    mkdirSync(artifactRoot, { recursive: true });
    let failFetch = true;
    const exec: ExtensionAPI["exec"] = (command, args, options) => {
      if (command === "git" && args[0] === "fetch" && failFetch) {
        failFetch = false;
        return Promise.resolve({
          code: 1,
          stdout: "",
          stderr: "fixture fetch failure",
          killed: false,
        });
      }
      return f.localExec(command, args, options);
    };
    const expected = { reviewId, head: f.metadata.headOid, files: ["head.txt"] };
    let actual: Record<string, unknown> = {};
    try {
      const first = await prepareResolvedSnapshot(
        exec,
        mocked.agentDir,
        f.metadata,
        undefined,
        reviewId,
        mocked.agentDir,
      ).catch((cause) => cause);
      const worktree = join(mocked.agentDir, "pr-review", "worktrees", reviewId);
      actual = { firstFailure: first.code, worktreeAfterFailure: existsSync(worktree) };
      expect(first).toMatchObject({ code: "fetch_failed" });
      expect(existsSync(worktree)).toBe(false);
      const snapshot = await prepareResolvedSnapshot(
        exec,
        mocked.agentDir,
        f.metadata,
        undefined,
        reviewId,
        mocked.agentDir,
      );
      actual = {
        ...actual,
        reviewId: snapshot.id,
        head: git(snapshot.worktree, "rev-parse", "HEAD"),
        files: snapshot.metadata.changedFiles.map((file) => file.path),
        diffVerified:
          createHash("sha256").update(readFileSync(snapshot.diffPath)).digest("hex") ===
          snapshot.diffHash,
        registered: git(snapshot.cache!.repoDir, "worktree", "list", "--porcelain").includes(
          worktree,
        ),
      };
      expect(actual).toMatchObject({
        firstFailure: "fetch_failed",
        worktreeAfterFailure: false,
        ...expected,
        diffVerified: true,
        registered: true,
      });
    } finally {
      writeFileSync(
        join(artifactRoot, "result.json"),
        JSON.stringify(
          {
            input: {
              source: "local bare Git fixture",
              base: f.metadata.baseOid,
              head: f.metadata.headOid,
              reviewId,
            },
            expected: {
              firstFailure: "fetch_failed",
              worktreeAfterFailure: false,
              ...expected,
              diffVerified: true,
              registered: true,
            },
            actual,
            reproduce:
              "nub run test:vitest .pi/extensions/review/__tests__/snapshot-git-integration.test.ts",
          },
          null,
          2,
        ),
      );
      console.info(`Review snapshot evidence: ${join(artifactRoot, "result.json")}`);
    }
  });

  it("unregisters a created worktree when later snapshot persistence fails", async () => {
    const f = fixture();
    const reviewId = "snapshot-persistence-failure";
    const artifactDir = join(mocked.agentDir, "pr-review", "artifacts", reviewId);
    const worktree = join(mocked.agentDir, "pr-review", "worktrees", reviewId);
    mkdirSync(join(artifactDir, "metadata.json"), { recursive: true });

    await expect(
      prepareResolvedSnapshot(
        f.localExec,
        mocked.agentDir,
        f.metadata,
        undefined,
        reviewId,
        mocked.agentDir,
      ),
    ).rejects.toMatchObject({
      code: "snapshot_failed",
      message: "Could not persist review snapshot metadata.",
    });

    const repoDir = join(mocked.agentDir, "pr-review", "repos", "acme", "widgets");
    expect(git(repoDir, "worktree", "list", "--porcelain")).not.toContain(worktree);
    expect(existsSync(worktree)).toBe(false);
    expect(existsSync(artifactDir)).toBe(false);
  });

  it("removes a failed worktree path before pruning its Git registration", async () => {
    const f = fixture();
    const snapshot = await prepareResolvedSnapshot(
      f.localExec,
      mocked.agentDir,
      f.metadata,
      undefined,
      undefined,
      mocked.agentDir,
    );
    let pathMissingAtPrune = false;
    const failingRemove: ExtensionAPI["exec"] = async (command, args, options) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "remove")
        return { code: 1, stdout: "", stderr: "forced removal failure", killed: false };
      if (command === "git" && args[0] === "worktree" && args[1] === "prune")
        pathMissingAtPrune = !existsSync(snapshot.worktree);
      return f.localExec(command, args, options);
    };
    const removed = await Effect.runPromise(
      removeManagedGitWorktreeEffect(
        failingRemove,
        f.metadata,
        snapshot.cache!.repoDir,
        snapshot.worktree,
      ),
    );
    expect(pathMissingAtPrune).toBe(true);
    expect(removed).toBe(true);
    expect(existsSync(snapshot.worktree)).toBe(false);
    expect(git(snapshot.cache!.repoDir, "worktree", "list", "--porcelain")).not.toContain(
      snapshot.worktree,
    );
  });

  it("repairs a shallow cache that has both tips but no merge base", async () => {
    const f = fixture();
    const repoDir = join(mocked.agentDir, "pr-review", "repos", "acme", "widgets");
    mkdirSync(repoDir, { recursive: true });
    git(repoDir, "init", "-q");
    git(repoDir, "remote", "add", "origin", `file://${f.origin}`);
    git(
      repoDir,
      "fetch",
      "-q",
      "--depth=1",
      "origin",
      `+refs/pull/7/head:refs/pi-pr-review/head/7/${f.metadata.headOid}`,
      "+refs/heads/trunk:refs/pi-pr-review/base/7/trunk",
    );
    expect(git(repoDir, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect(() => git(repoDir, "merge-base", f.metadata.baseOid, f.metadata.headOid)).toThrow();

    const snapshot = await prepareResolvedSnapshot(
      f.localExec,
      mocked.agentDir,
      f.metadata,
      undefined,
      undefined,
      mocked.agentDir,
    );
    expect(existsSync(snapshot.diffPath)).toBe(true);
    expect(git(repoDir, "rev-parse", "--is-shallow-repository")).toBe("false");
    expect(git(repoDir, "merge-base", f.metadata.baseOid, f.metadata.headOid)).toBe(f.commonOid);
  });
});
