import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type * as CodingAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveNodeCommand } from "../../../../src/process/platform.js";
import { managedGitExec, prepareResolvedSnapshot } from "../snapshot";

const mocked = vi.hoisted(() => ({ agentDir: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (orig) => ({
  ...(await orig<typeof CodingAgent>()),
  getAgentDir: () => mocked.agentDir,
}));

const temps: string[] = [];
afterEach(() => {
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
  it("terminates the complete command process group on cancellation", async () => {
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
  }, 10_000);

  it("prepares a fresh snapshot for divergent base and head histories", async () => {
    const f = fixture();
    const snapshot = await prepareResolvedSnapshot(f.localExec, mocked.agentDir, f.metadata);
    expect(snapshot.metadata.changedFiles).toEqual([{ path: "head.txt" }]);
    expect(existsSync(snapshot.diffPath)).toBe(true);
    expect(git(snapshot.cache!.repoDir, "merge-base", f.metadata.baseOid, f.metadata.headOid)).toBe(
      f.commonOid,
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

    const snapshot = await prepareResolvedSnapshot(f.localExec, mocked.agentDir, f.metadata);
    expect(existsSync(snapshot.diffPath)).toBe(true);
    expect(git(repoDir, "rev-parse", "--is-shallow-repository")).toBe("false");
    expect(git(repoDir, "merge-base", f.metadata.baseOid, f.metadata.headOid)).toBe(f.commonOid);
  });
});
