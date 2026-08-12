import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import prReviewExtension, {
  clearInMemoryStateForTests,
  restore,
  setPrReviewSubagentRunnerForTests,
} from "../index";
import { REVIEW_ENTRY_TYPE, type ReviewState } from "../core";

const mocked = vi.hoisted(() => ({ agentDir: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (orig) => ({
  ...(await orig<typeof import("@earendil-works/pi-coding-agent")>()),
  getAgentDir: () => mocked.agentDir,
}));
const temps: string[] = [];
afterEach(() => {
  clearInMemoryStateForTests();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-pr-review-agent-"));
  temps.push(dir);
  mocked.agentDir = dir;
  return dir;
}
function custom(state: ReviewState) {
  return {
    type: "custom",
    customType: REVIEW_ENTRY_TYPE,
    data: { reviewId: state.snapshot.id, state },
  };
}
function sampleState(id: string, selected: string[]): ReviewState {
  const root = mocked.agentDir || tempRoot();
  return {
    snapshot: {
      id,
      artifactDir: `${root}/pr-review/artifacts/${id}`,
      worktree: `${root}/pr-review/worktrees/${id}`,
      diffPath: `${root}/pr-review/artifacts/${id}/diff.patch`,
      diffHash: "h",
      createdAt: "now",
      cache: {
        repoDir: `${root}/pr-review/repos/o/r`,
        worktree: `${root}/pr-review/worktrees/${id}`,
      },
      metadata: {
        owner: "o",
        repo: "r",
        number: 1,
        url: "https://github.com/o/r/pull/1",
        baseOid: "b",
        headOid: "h",
        changedFiles: [{ path: "a.ts" }],
      },
    },
    selectedFindingIds: selected,
    posts: [],
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
          problem: "p",
          consequence: "c",
          suggestedFix: "f",
          selected: true,
        },
      ],
    },
  };
}

function extensionPi() {
  const tools: any[] = [];
  const commands: Record<string, any> = {};
  const handlers: Record<string, any> = {};
  const pi: any = {
    tools,
    commands,
    handlers,
    appended: [] as any[],
    registerTool(tool: any) {
      tools.push(tool);
    },
    registerCommand(name: string, opts: any) {
      commands[name] = opts;
      this.command = opts.handler;
    },
    on(name: string, handler: any) {
      handlers[name] = handler;
    },
    appendEntry(...args: any[]) {
      this.appended.push(args);
    },
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  prReviewExtension(pi);
  return pi;
}

describe("pr-review extension surface", () => {
  it("registers prompt metadata and explicit command surface", () => {
    tempRoot();
    const pi = extensionPi();
    const start = pi.tools.find((t: any) => t.name === "pr_review_start");
    expect(start).toBeTruthy();
    expect(start.description).toContain("Review this PR");
    expect(start.description).toContain("must not perform the review");
    expect(start.promptSnippet).toBe("Review this PR");
    expect(start.promptGuidelines[0]).toContain("Do not inspect files");
    expect(pi.commands.review.description).toContain("edit");
    expect(pi.handlers.session_start).toBeTypeOf("function");
    expect(pi.handlers.session_tree).toBeTypeOf("function");
  });

  it("replays only active custom entries from the supplied immutable session path", async () => {
    tempRoot();
    const first = sampleState("r-one", ["F1"]);
    const cleaned = { ...sampleState("r-clean", ["F1"]), cleaned: true };
    const second = sampleState("r-two", []);
    restore({ sessionManager: { getBranch: () => [custom(cleaned), custom(first)] } } as any);
    const pi = extensionPi();
    const notes: string[] = [];
    await pi.command("status", { ui: { notify: (m: string) => notes.push(m) } } as any);
    expect(notes.at(-1)).toContain("Selected: 1");
    clearInMemoryStateForTests();
    restore({
      sessionManager: { getBranch: () => [custom(first), custom(cleaned), custom(second)] },
    } as any);
    await pi.command("status", { ui: { notify: (m: string) => notes.push(m) } } as any);
    expect(notes.at(-1)).toContain("Selected: 0");
  });

  it("cleanup uses a temporary managed root and appends durable cleanup state", async () => {
    const root = tempRoot();
    const state = sampleState("r", []);
    mkdirSync(state.snapshot.cache!.repoDir, { recursive: true });
    mkdirSync(state.snapshot.cache!.worktree, { recursive: true });
    restore({ sessionManager: { getBranch: () => [custom(state)] } } as any);
    const pi = extensionPi();
    const calls: any[] = [];
    pi.exec = async (cmd: string, args: string[], opts: any) => {
      calls.push({ cmd, args, cwd: opts.cwd });
      return { code: 0, stdout: "", stderr: "" };
    };
    await pi.command("cleanup", { ui: { notify() {} } } as any);
    await pi.command("cleanup", { ui: { notify() {} } } as any);
    expect(calls.filter((c) => c.args[0] === "worktree" && c.args[1] === "remove")).toHaveLength(1);
    expect(pi.appended.at(-1)?.[1].state.cleaned).toBe(true);
    expect(pi.appended.at(-1)?.[1].state.snapshot.cache.repoDir).toContain(root);
  });

  it("edit and preface cancellation do not append mutated state", async () => {
    tempRoot();
    const state = sampleState("r", []);
    restore({ sessionManager: { getBranch: () => [custom(state)] } } as any);
    const pi = extensionPi();
    const notes: string[] = [];
    await pi.command("edit F1", {
      ui: { notify: (m: string) => notes.push(m), editor: async () => undefined },
    } as any);
    await pi.command("preface", {
      ui: { notify: (m: string) => notes.push(m), editor: async () => undefined },
    } as any);
    expect(notes).toContain("Edit cancelled.");
    expect(notes).toContain("Preface edit cancelled.");
    expect(pi.appended).toHaveLength(0);
  });

  it("persists initial snapshot if model resolution fails", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "pr-review", "artifacts"), { recursive: true });
    const pi = extensionPi();
    pi.exec = async (cmd: string, args: string[]) => {
      if (cmd === "gh")
        return {
          code: 0,
          stdout: JSON.stringify({
            url: "https://github.com/o/r/pull/1",
            baseRefName: "trunk",
            baseRefOid: "b",
            headRefOid: "h",
          }),
          stderr: "",
        };
      if (args[0] === "rev-parse")
        return {
          code: 0,
          stdout: `${args[1]!.startsWith("refs/pi-pr-review/base") ? "b" : "h"}\n`,
          stderr: "",
        };
      if (args[0] === "merge-base") return { code: 0, stdout: "b\n", stderr: "" };
      if (args[0] === "diff" && args.includes("--name-status"))
        return { code: 0, stdout: "A\0a.ts\0", stderr: "" };
      return { code: 0, stdout: "diff --git a/a.ts b/a.ts\n", stderr: "" };
    };
    const ctx: any = { cwd: root, modelRegistry: { getAvailable: () => [] } };
    await expect(
      pi.tools[0].execute("1", { url: "https://github.com/o/r/pull/1" }, undefined, undefined, ctx),
    ).rejects.toThrow(/No usable model/);
    expect(pi.appended[0]?.[0]).toBe(REVIEW_ENTRY_TYPE);
    expect(pi.appended[0]?.[1].state.child).toBeUndefined();
    expect(pi.appended.at(-1)?.[1].state.child.isError).toBe(true);
  });

  it("preserves child runtime errors, missing submissions, signal, and scoped tools", async () => {
    tempRoot();
    const state = sampleState("r", []);
    setPrReviewSubagentRunnerForTests((run, _ctx, options) =>
      Effect.sync(() => {
        expect(run.toolNames).toContain("review_changed_files");
        expect(
          run.toolNames.every((n) => n.startsWith("review_") || n.startsWith("submit_review")),
        ).toBe(true);
        expect(run.systemPrompt).toContain("fresh pull request review agent");
        expect(run.task).toContain("Use review_changed_files");
        expect(run.tools.map((t) => t.name).sort()).toEqual([...run.toolNames].sort());
        expect(options?.signal).toBe(ac.signal);
        return {
          content: [],
          details: {
            isError: true,
            sessionFile: "child.json",
            sessionName: "child",
            toolNames: run.toolNames,
          },
        } as any;
      }),
    );
    const pi = extensionPi();
    pi.exec = async (cmd: string, args: string[]) => {
      if (cmd === "gh")
        return {
          code: 0,
          stdout: JSON.stringify({
            url: "https://github.com/o/r/pull/1",
            baseRefName: "trunk",
            baseRefOid: "b",
            headRefOid: "h",
          }),
          stderr: "",
        };
      if (args[0] === "rev-parse")
        return {
          code: 0,
          stdout: `${args[1]!.startsWith("refs/pi-pr-review/base") ? "b" : "h"}\n`,
          stderr: "",
        };
      if (args[0] === "merge-base") return { code: 0, stdout: "b\n", stderr: "" };
      if (args[0] === "diff" && args.includes("--name-status"))
        return { code: 0, stdout: "A\0a.ts\0", stderr: "" };
      return { code: 0, stdout: "diff --git a/a.ts b/a.ts\n", stderr: "" };
    };
    const ac = new AbortController();
    const ctx: any = {
      cwd: state.snapshot.worktree,
      modelRegistry: { getAvailable: () => [{ provider: "p", id: "m" }] },
    };
    await expect(
      pi.tools[0].execute("1", { url: "https://github.com/o/r/pull/1" }, ac.signal, undefined, ctx),
    ).rejects.toThrow(/valid plan and final review/);
    expect(pi.appended.at(-1)?.[1].state.child).toMatchObject({
      isError: true,
      sessionFile: "child.json",
    });
  });
});
