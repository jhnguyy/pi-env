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
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveNodeCommand } from "../../../../src/process/platform.js";
import {
  managedGitExec,
  prepareResolvedSnapshot,
  removeManagedGitWorktreeEffect,
  reviewGitExec,
} from "../snapshot";

import { git, reviewRepo } from "./fixtures/review-repo";

const mocked = { agentDir: "" };
const commandTreeUrl = new URL("./fixtures/command-tree.ts", import.meta.url);
const commandTreePath = fileURLToPath(commandTreeUrl);

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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function withOwnedCommand(
  controller: AbortController,
  running: Promise<unknown>,
  parentPidPath: string,
  childPidPath: string,
  check: () => Promise<void>,
): Promise<void> {
  const settled = running.catch(() => {});
  const failures: unknown[] = [];
  try {
    await check();
  } catch (cause) {
    failures.push(cause);
  } finally {
    controller.abort();
    await settled;
    const pids: number[] = [];
    for (const pidPath of [parentPidPath, childPidPath]) {
      try {
        if (!existsSync(pidPath)) continue;
        const pid = Number(readFileSync(pidPath, "utf8"));
        if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid)
          throw new Error(`Unsafe fixture PID in ${pidPath}`);
        pids.push(pid);
        expect(existsSync(`${pidPath}.watchdog`)).toBe(false);
      } catch (cause) {
        failures.push(cause);
      }
    }
    try {
      await vi.waitFor(() => {
        for (const pid of pids) expect(processIsAlive(pid)).toBe(false);
      });
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Command fixture operation or cleanup failed");
}

function fixture() {
  mocked.agentDir = temp("pi-review-agent-");
  return reviewRepo();
}

describe("review snapshot Git integration", () => {
  it.skipIf(process.platform === "win32")(
    "terminates the complete command process group on cancellation",
    async () => {
      const root = temp("pi-review-process-");
      const parentPidPath = join(root, "parent.pid");
      const childPidPath = join(root, "child.pid");
      const node = resolveNodeCommand();

      const controller = new AbortController();
      const running = managedGitExec(node, [commandTreePath, parentPidPath, childPidPath], {
        cwd: root,
        signal: controller.signal,
        timeout: 10_000,
      });
      await withOwnedCommand(controller, running, parentPidPath, childPidPath, async () => {
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
      writeFileSync(
        fakeGit,
        `#!${node}\n` +
          `process.argv = [process.execPath, ${JSON.stringify(commandTreePath)}, ${JSON.stringify(parentPidPath)}, ${JSON.stringify(childPidPath)}];\n` +
          `import(${JSON.stringify(commandTreeUrl.href)});\n`,
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
      await withOwnedCommand(controller, running, parentPidPath, childPidPath, async () => {
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
      });
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
              "nub run test:integration .pi/extensions/review/__tests__/snapshot-git.integration.test.ts",
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
