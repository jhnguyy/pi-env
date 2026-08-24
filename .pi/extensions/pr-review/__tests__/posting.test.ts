import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type * as CodingAgent from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REVIEW_ENTRY_TYPE, ReviewEvent, type ReviewState } from "../core";
import { clearInMemoryStateForTests, postReview, restore } from "../index";

const mocked = vi.hoisted(() => ({ agentDir: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (orig) => ({
  ...(await orig<typeof CodingAgent>()),
  getAgentDir: () => mocked.agentDir,
}));
const temps: string[] = [];
afterEach(() => {
  clearInMemoryStateForTests();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function root() {
  mocked.agentDir = mkdtempSync(join(tmpdir(), "pi-pr-review-agent-"));
  temps.push(mocked.agentDir);
  return mocked.agentDir;
}
function state(): ReviewState {
  const base = `${root()}/pr-review`;
  mkdirSync(`${base}/artifacts/r`, { recursive: true });
  return {
    snapshot: {
      id: "r",
      artifactDir: `${base}/artifacts/r`,
      worktree: `${base}/worktrees/r`,
      diffPath: `${base}/artifacts/r/diff.patch`,
      diffHash: "h",
      createdAt: "now",
      metadata: {
        owner: "o",
        repo: "repo",
        number: 2,
        url: "https://github.com/o/repo/pull/2",
        baseOid: "b",
        headOid: "head",
        changedFiles: [{ path: "a.ts" }],
      },
    },
    plan: {
      goal: "g",
      goalAssessment: "a",
      risk: "r",
      riskReasons: [],
      cohorts: [{ label: "main", purpose: "review changed file", paths: ["a.ts"] }],
      files: [{ path: "a.ts", attention: "normal", role: "changed file" }],
    },
    result: {
      verdict: "v",
      findings: [
        {
          id: "F1",
          severity: "serious",
          impact: "low",
          file: "a.ts",
          side: "RIGHT",
          line: 3,
          problem: "p",
          consequence: "c",
          suggestedFix: "f",
          selected: true,
          anchorValid: true,
        },
        {
          id: "F2",
          severity: "serious",
          impact: "low",
          problem: "u",
          consequence: "c",
          suggestedFix: "f",
          selected: true,
          anchorValid: false,
        },
      ],
    },
    selectedFindingIds: ["F1", "F2"],
    posts: [],
  };
}
function custom(s: ReviewState) {
  return {
    type: "custom",
    customType: REVIEW_ENTRY_TYPE,
    data: { reviewId: s.snapshot.id, state: s },
  };
}

describe("pr-review posting", () => {
  it("uses GET pagination, persists pending before POST, and reuses uncertain attempt on retry", async () => {
    const s = state();
    restore({ sessionManager: { getBranch: () => [custom(s)] } } as any);
    const calls: any[] = [];
    const appended: any[] = [];
    let persistedMarker = "";
    let callNo = 0;
    const pi = {
      appendEntry(_type: string, data: any) {
        appended.push(data);
        persistedMarker = data.state.posts[0]?.marker ?? persistedMarker;
      },
      exec: async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        if (cmd === "gh" && args[0] === "pr") return { code: 0, stdout: "head\n", stderr: "" };
        if (cmd === "gh" && args[0] === "api" && args.includes("--method")) {
          callNo += 1;
          return {
            code: 0,
            stdout:
              callNo >= 2 && persistedMarker
                ? JSON.stringify([{ id: "remote1", body: persistedMarker }])
                : "[]",
            stderr: "",
          };
        }
        if (cmd === "gh" && args[0] === "api" && args[1] === "-X")
          return { code: 1, stdout: "", stderr: "lost" };
        return { code: 1, stdout: "", stderr: "bad" };
      },
    };
    const confirms: any[] = [];
    const ctx = {
      cwd: "/tmp",
      ui: {
        confirm: async (title: string, message: string) => {
          confirms.push([title, message]);
          return true;
        },
      },
    };
    expect(await postReview(pi as any, ctx as any, ReviewEvent.Comment)).toContain("uncertain");
    expect(appended.some((a) => a.state.posts[0]?.status === "pending")).toBe(true);
    expect(await postReview(pi as any, ctx as any, ReviewEvent.Comment)).toContain(
      "not posting duplicate",
    );
    expect(calls.filter((c) => c.args[0] === "api" && c.args[1] === "-X")).toHaveLength(1);
    expect(
      calls.filter((c) => c.args.includes("--method") && c.args.includes("GET")).length,
    ).toBeGreaterThan(0);
    expect(confirms).toHaveLength(1);
    expect(confirms[0][1]).toContain("Preface preview:\n(none)");
    expect(persistedMarker).toBe(
      "<!-- pi-env-pr-review:r:" + appended[0].state.posts[0].id + " -->",
    );
  });

  it("does not repost while an earlier attempt remains uncertain", async () => {
    restore({ sessionManager: { getBranch: () => [custom(state())] } } as any);
    let posts = 0;
    const pi = {
      appendEntry() {},
      exec: async (_cmd: string, args: string[]) => {
        if (args[0] === "pr") return { code: 0, stdout: "head\n", stderr: "" };
        if (args.includes("--method")) return { code: 0, stdout: "[]", stderr: "" };
        posts += 1;
        return { code: 1, stdout: "", stderr: "lost" };
      },
    };
    const ctx = { cwd: "/tmp", ui: { confirm: async () => true } };
    expect(await postReview(pi as any, ctx as any, ReviewEvent.Comment)).toContain("uncertain");
    expect(await postReview(pi as any, ctx as any, ReviewEvent.Comment)).toContain(
      "still uncertain",
    );
    expect(posts).toBe(1);
  });

  it("serializes concurrent identical posts and posts once", async () => {
    const s = { ...state(), preface: "hello\n".repeat(200) };
    restore({ sessionManager: { getBranch: () => [custom(s)] } } as any);
    let posts = 0;
    const confirms: any[] = [];
    let releasePost!: () => void;
    const postEntered = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    const pi = {
      appendEntry(_type: string, data: any) {
        restore({ sessionManager: { getBranch: () => [custom(data.state)] } } as any);
      },
      exec: async (cmd: string, args: string[]) => {
        if (cmd === "gh" && args[0] === "pr") return { code: 0, stdout: "head\n", stderr: "" };
        if (cmd === "gh" && args[0] === "api" && args.includes("--method"))
          return { code: 0, stdout: "[]", stderr: "" };
        if (cmd === "gh" && args[0] === "api" && args[1] === "-X") {
          posts += 1;
          if (posts === 1) await postEntered;
          return { code: 0, stdout: JSON.stringify({ id: `remote${posts}` }), stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "bad" };
      },
    };
    const ctx = {
      cwd: "/tmp",
      ui: {
        confirm: async (_title: string, message: string) => {
          confirms.push(message);
          return true;
        },
      },
    };
    const first = postReview(pi as any, ctx as any, ReviewEvent.Comment);
    const second = postReview(pi as any, ctx as any, ReviewEvent.Comment);
    await Promise.resolve();
    releasePost();
    await expect(Promise.all([first, second])).resolves.toEqual([
      "Review posted.",
      "Review already posted (remote1).",
    ]);
    expect(posts).toBe(1);
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toContain("Preface preview:");
    expect(confirms[0].length).toBeLessThan(700);
  });

  it("blocks posting before confirmation when the remote head is stale", async () => {
    const s = state();
    restore({ sessionManager: { getBranch: () => [custom(s)] } } as any);
    let confirmed = false;
    let posted = false;
    const pi = {
      appendEntry() {},
      exec: async (_cmd: string, args: string[]) => {
        if (args[0] === "pr") return { code: 0, stdout: "new-head\n", stderr: "" };
        posted = true;
        return { code: 0, stdout: "{}", stderr: "" };
      },
    } as any;
    const ctx = {
      ui: {
        confirm: async () => {
          confirmed = true;
          return true;
        },
      },
    } as any;
    await expect(postReview(pi, ctx, ReviewEvent.Comment)).resolves.toMatch(/stale/);
    expect(confirmed).toBe(false);
    expect(posted).toBe(false);
  });

  it("rejects unknown post events through the command", async () => {
    restore({ sessionManager: { getBranch: () => [custom(state())] } } as any);
    const notes: string[] = [];
    const pi: any = {
      registerTool() {},
      on() {},
      appendEntry() {},
      exec: async () => ({ code: 0, stdout: "head\n", stderr: "" }),
      registerCommand(_n: string, opts: any) {
        this.command = opts.handler;
      },
    };
    (await import("../index")).default(pi);
    await pi.command("post merge", {
      ui: { notify: (m: string) => notes.push(m), confirm: async () => true },
      cwd: "/tmp",
    } as any);
    expect(notes.at(-1)).toContain("Unknown review post event");
  });
});
