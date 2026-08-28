import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type * as CodingAgent from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import {
  prepareResolvedSnapshot,
  prepareSnapshot,
  prepareSnapshotEffect,
  resolvePrUrl,
} from "../snapshot";

const mocked = vi.hoisted(() => ({ agentDir: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (orig) => ({
  ...(await orig<typeof CodingAgent>()),
  getAgentDir: () => mocked.agentDir,
}));
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function roots() {
  mocked.agentDir = mkdtempSync(join(tmpdir(), "pi-pr-review-agent-"));
  temps.push(mocked.agentDir);
  const cwd = mkdtempSync(join(tmpdir(), "pi-pr-review-cwd-"));
  temps.push(cwd);
  return cwd;
}
function execFor(meta: any, mismatch = false) {
  const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
  let lastFetch = "";
  const exec = async (cmd: string, args: string[], opts: any = {}) => {
    calls.push({ cmd, args, cwd: opts.cwd });
    if (cmd === "gh" && args[1] === "view")
      return { code: 0, stdout: JSON.stringify(meta), stderr: "" } as any;
    if (cmd === "git" && args[0] === "fetch") {
      lastFetch = args.at(-1)!;
      return { code: 0, stdout: "", stderr: "" } as any;
    }
    if (cmd === "git" && args[0] === "rev-parse") {
      const expected = lastFetch.startsWith("+refs/pull/") ? meta.headRefOid : meta.baseRefOid;
      return { code: 0, stdout: `${mismatch ? "bad" : expected}\n`, stderr: "" } as any;
    }
    if (cmd === "git" && args[0] === "merge-base")
      return { code: 0, stdout: `${meta.baseRefOid}\n`, stderr: "" } as any;
    if (cmd === "git" && args[0] === "diff" && args.includes("--name-status"))
      return {
        code: 0,
        stdout: "R100\0old name.ts\0new name.ts\0A\0space path.ts\0",
        stderr: "",
      } as any;
    if (cmd === "git" && args[0] === "worktree" && args[1] === "add")
      mkdirSync(args[3], { recursive: true });
    if (cmd === "git" && args[0] === "diff")
      return {
        code: 0,
        stdout: "diff --git a/new name.ts b/new name.ts\n--- a/new name.ts\n+++ b/new name.ts\n",
        stderr: "",
      } as any;
    return { code: 0, stdout: "", stderr: "" } as any;
  };
  return { exec, calls };
}

describe("review pull request snapshot", () => {
  it("returns a clear needs-url message when gh cannot resolve the pull request", async () => {
    const missing = await resolvePrUrl(
      async () => ({ code: 1, stdout: "", stderr: "no pr" }) as any,
      roots(),
    );
    expect(missing.message).toContain("Please provide a GitHub PR URL");
  });

  it("pins private base/head refs, verifies exact OIDs, and preserves NUL name-status semantics", async () => {
    const cwd = roots();
    const head = "abcdef1234567890";
    const base = "0123456789abcdef";
    const { exec, calls } = execFor({
      url: "https://github.com/acme/widgets/pull/7",
      title: "T",
      baseRefName: "trunk",
      baseRefOid: base,
      headRefOid: head,
    });
    const snap = await prepareSnapshot(exec as any, cwd, "https://github.com/acme/widgets/pull/7");
    expect(snap.metadata.changedFiles).toEqual([
      { path: "new name.ts" },
      { path: "space path.ts" },
    ]);
    expect(statSync(snap.cache!.repoDir).mode & 0o777).toBe(0o700);
    expect(statSync(snap.artifactDir).mode & 0o777).toBe(0o700);
    expect(statSync(snap.worktree).mode & 0o777).toBe(0o700);
    expect(statSync(snap.diffPath).mode & 0o777).toBe(0o600);
    expect(
      calls.some(
        (c) =>
          c.args[0] === "fetch" &&
          c.args.at(-1)!.startsWith("+refs/pull/7/head:refs/pi-pr-review/head/7/"),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (c) =>
          c.args[0] === "fetch" && c.args.at(-1)!.startsWith(`+${base}:refs/pi-pr-review/base/7/`),
      ),
    ).toBe(true);
  });

  it("repairs restrictive permissions on reused artifact paths", async () => {
    const cwd = roots();
    const reviewId = "acme-widgets-7-fixed";
    const artifactDir = join(mocked.agentDir, "pr-review", "artifacts", reviewId);
    const diffPath = join(artifactDir, "diff.patch");
    mkdirSync(artifactDir, { recursive: true, mode: 0o777 });
    chmodSync(artifactDir, 0o777);
    writeFileSync(diffPath, "stale", { mode: 0o666 });
    chmodSync(diffPath, 0o666);
    const head = "abcdef1234567890";
    const base = "0123456789abcdef";
    const { exec } = execFor({ headRefOid: head, baseRefOid: base });
    const snap = await prepareResolvedSnapshot(
      exec as any,
      cwd,
      {
        owner: "acme",
        repo: "widgets",
        number: 7,
        url: "https://github.com/acme/widgets/pull/7",
        baseRef: "trunk",
        baseOid: base,
        headOid: head,
        changedFiles: [],
      },
      undefined,
      reviewId,
    );
    expect(statSync(snap.artifactDir).mode & 0o777).toBe(0o700);
    expect(statSync(snap.diffPath).mode & 0o777).toBe(0o600);
  });

  it("fails absent base name/OID and exact ref mismatches", async () => {
    const cwd = roots();
    await expect(
      prepareSnapshot(
        execFor({ url: "https://github.com/acme/widgets/pull/7", baseRefOid: "b", headRefOid: "h" })
          .exec as any,
        cwd,
        "https://github.com/acme/widgets/pull/7",
      ),
    ).rejects.toThrow(/base branch/);
    await expect(
      prepareSnapshot(
        execFor(
          {
            url: "https://github.com/acme/widgets/pull/7",
            baseRefName: "trunk",
            baseRefOid: "b",
            headRefOid: "h",
          },
          true,
        ).exec as any,
        cwd,
        "https://github.com/acme/widgets/pull/7",
      ),
    ).rejects.toThrow(/did not match/);
  });

  it("serializes preparations for the same repository", async () => {
    const cwd = roots();
    let active = 0;
    let overlap = false;
    const { exec } = execFor({
      url: "https://github.com/acme/widgets/pull/7",
      baseRefName: "trunk",
      baseRefOid: "b",
      headRefOid: "h",
    });
    let releaseFirst: (() => void) | undefined;
    let markEntered: (() => void) | undefined;
    const firstFetchEntered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const firstFetchRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let fetches = 0;
    const lockedExec = async (cmd: string, args: string[], opts: any) => {
      if (cmd === "git" && args[0] === "fetch") {
        active += 1;
        fetches += 1;
        if (active > 1) overlap = true;
        if (fetches === 1) {
          markEntered?.();
          await firstFetchRelease;
        }
        active -= 1;
      }
      return exec(cmd, args, opts);
    };
    const first = prepareSnapshot(lockedExec as any, cwd, "https://github.com/acme/widgets/pull/7");
    const second = prepareSnapshot(
      lockedExec as any,
      cwd,
      "https://github.com/acme/widgets/pull/7",
    );
    await firstFetchEntered;
    expect(active).toBe(1);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(overlap).toBe(false);
  });

  it("cleans artifact and worktree on failure", async () => {
    const cwd = roots();
    const { exec } = execFor({
      url: "https://github.com/acme/widgets/pull/7",
      baseRefName: "trunk",
      baseRefOid: "b",
      headRefOid: "h",
    });
    const failingExec = async (cmd: string, args: string[], opts: any) => {
      if (cmd === "git" && args[0] === "worktree")
        return { code: 1, stdout: "", stderr: "no" } as any;
      return exec(cmd, args, opts);
    };
    await expect(
      Effect.runPromise(
        prepareSnapshotEffect(failingExec as any, cwd, "https://github.com/acme/widgets/pull/7"),
      ),
    ).rejects.toThrow(/worktree/);
    expect(readdirSync(join(mocked.agentDir, "pr-review", "artifacts"))).toEqual([]);
    expect(existsSync(join(mocked.agentDir, "pr-review", "worktrees"))).toBe(false);
  });
});
