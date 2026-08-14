import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import prReviewExtension, {
  applyFindingTemplateEditAction,
  clearInMemoryStateForTests,
  getLatestReviewState,
  restore,
  setFindingSelectionAction,
  setPrReviewSubagentRunnerForTests,
  updatePrefaceAction,
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
  const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n same\n+new\n";
  mkdirSync(`${root}/pr-review/artifacts/${id}`, { recursive: true });
  writeFileSync(`${root}/pr-review/artifacts/${id}/diff.patch`, diff);
  return {
    snapshot: {
      id,
      artifactDir: `${root}/pr-review/artifacts/${id}`,
      worktree: `${root}/pr-review/worktrees/${id}`,
      diffPath: `${root}/pr-review/artifacts/${id}/diff.patch`,
      diffHash: createHash("sha256").update(diff).digest("hex"),
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
          selected: false,
          file: "a.ts",
          side: "RIGHT",
          line: 2,
          anchorValid: true,
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

  it("exposes immutable latest active state", () => {
    tempRoot();
    const state = sampleState("r", ["F1"]);
    restore({ sessionManager: { getBranch: () => [custom(state)] } } as any);
    const latest = getLatestReviewState() as ReviewState;
    expect(latest.snapshot.id).toBe("r");
    expect(() => ((latest as any).selectedFindingIds = [])).toThrow();
    expect(() => ((latest.result!.findings[0] as any).problem = "changed")).toThrow();
    expect(getLatestReviewState()!.result!.findings[0]!.problem).toBe("p");
  });

  it("persists one-finding selection through the shared action", () => {
    tempRoot();
    const state = sampleState("r", []);
    restore({ sessionManager: { getBranch: () => [custom(state)] } } as any);
    const pi = extensionPi();
    expect(setFindingSelectionAction(pi, "F1", true)).toMatchObject({ status: "updated" });
    expect(pi.appended.at(-1)?.[1].state.selectedFindingIds).toEqual(["F1"]);
    expect(setFindingSelectionAction(pi, "F1", false)).toMatchObject({ status: "updated" });
    expect(pi.appended.at(-1)?.[1].state.selectedFindingIds).toEqual([]);
  });

  it("applies shared finding-template and preface edits", () => {
    tempRoot();
    const state = sampleState("r", []);
    restore({ sessionManager: { getBranch: () => [custom(state)] } } as any);
    const pi = extensionPi();
    expect(
      applyFindingTemplateEditAction(
        pi,
        "F1",
        "Problem: new p\nConsequence: new c\nSuggested fix: new f",
      ),
    ).toMatchObject({ status: "updated" });
    expect(updatePrefaceAction(pi, "Ready for review.")).toMatchObject({ status: "updated" });
    expect(pi.appended.at(-1)?.[1].state.result.findings[0].problem).toBe("new p");
    expect(pi.appended.at(-1)?.[1].state.preface).toBe("Ready for review.");
    expect(() => applyFindingTemplateEditAction(pi, "F1", "Problem: incomplete")).toThrow(
      /malformed/,
    );
  });

  it("opens walkthrough only in TUI and falls back in other modes", async () => {
    tempRoot();
    restore({ sessionManager: { getBranch: () => [custom(sampleState("r", ["F1"]))] } } as any);
    const pi = extensionPi();
    const notes: string[] = [];
    let customCalls = 0;
    await pi.command("walkthrough", {
      mode: "json",
      ui: { notify: (m: string) => notes.push(m), custom: async () => { customCalls += 1; } },
    } as any);
    expect(notes.at(-1)).toContain("TUI mode");
    expect(customCalls).toBe(0);

    await pi.command("walkthrough", {
      mode: "tui",
      ui: {
        notify: (m: string) => notes.push(m),
        custom: async (_factory: any) => {
          customCalls += 1;
          return { kind: "cancel" };
        },
      },
    } as any);
    expect(customCalls).toBe(1);
    expect(notes.at(-1)).toContain("closed");
  });

  it("walkthrough reports no active review without opening custom UI", async () => {
    tempRoot();
    const pi = extensionPi();
    const notes: string[] = [];
    let customCalls = 0;
    await pi.command("walkthrough", {
      mode: "tui",
      ui: { notify: (m: string) => notes.push(m), custom: async () => { customCalls += 1; } },
    } as any);
    expect(notes.at(-1)).toContain("No active PR review");
    expect(customCalls).toBe(0);
  });

  it("walkthrough production component does not close on navigation but closes on durable key", async () => {
    tempRoot();
    restore({ sessionManager: { getBranch: () => [custom(sampleState("r", []))] } } as any);
    const pi = extensionPi();
    const notes: string[] = [];
    await pi.command("walkthrough", {
      mode: "tui",
      ui: {
        notify: (m: string) => notes.push(m),
        custom: async (factory: any) =>
          await new Promise((resolve) => {
            const component = factory(
              { requestRender() {}, terminal: { rows: 20 } },
              {},
              { matches: (data: string, id: string) => data === "escape" && id === "tui.select.cancel" },
              resolve,
            );
            component.handleInput("\x1b[C");
            component.handleInput("\x1b[D");
            component.handleInput("escape");
          }),
      },
    } as any);
    expect(notes.at(-1)).toContain("closed");
  });

  it("walkthrough persists selection after component closes and reopens from latest state", async () => {
    tempRoot();
    restore({ sessionManager: { getBranch: () => [custom(sampleState("r", []))] } } as any);
    const pi = extensionPi();
    const seenSelected: number[] = [];
    const intents = [{ kind: "toggleSelection", findingId: "F1" }, { kind: "cancel" }];
    await pi.command("walkthrough", {
      mode: "tui",
      ui: {
        notify() {},
        custom: async (factory: any) => {
          const component = factory({ requestRender() {}, terminal: { rows: 20 } }, {}, { matches: () => false }, () => {});
          seenSelected.push((component as any).options.viewModel.counts.selectedFindings);
          return intents.shift();
        },
      },
    } as any);
    expect(seenSelected).toEqual([0, 1]);
    expect(pi.appended.at(-1)?.[1].state.selectedFindingIds).toEqual(["F1"]);
  });

  it("walkthrough treats cancelled edit, cleanup, and post event selection as notices without mutations", async () => {
    tempRoot();
    restore({ sessionManager: { getBranch: () => [custom(sampleState("r", ["F1"]))] } } as any);
    const pi = extensionPi();
    const intents = [
      { kind: "edit", findingId: "F1" },
      { kind: "cleanup" },
      { kind: "post" },
      { kind: "cancel" },
    ];
    await pi.command("walkthrough", {
      mode: "tui",
      ui: {
        notify() {},
        editor: async () => undefined,
        select: async () => undefined,
        custom: async () => intents.shift(),
      },
    } as any);
    expect(pi.appended).toHaveLength(0);
  });

  it("walkthrough uses explicit event selection for posting", async () => {
    tempRoot();
    restore({ sessionManager: { getBranch: () => [custom(sampleState("r", ["F1"]))] } } as any);
    const pi = extensionPi();
    const calls: any[] = [];
    pi.exec = async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (cmd === "gh" && args[0] === "pr") return { code: 0, stdout: "h\n", stderr: "" };
      if (cmd === "gh" && args[0] === "api" && args.includes("--method")) return { code: 0, stdout: "[]", stderr: "" };
      if (cmd === "gh" && args[0] === "api" && args[1] === "-X") return { code: 0, stdout: JSON.stringify({ id: "remote" }), stderr: "" };
      return { code: 1, stdout: "", stderr: "bad" };
    };
    const intents = [{ kind: "post" }, { kind: "cancel" }];
    await pi.command("walkthrough", {
      mode: "tui",
      cwd: "/tmp",
      ui: {
        notify() {},
        confirm: async () => true,
        select: async () => "REQUEST_CHANGES",
        custom: async () => intents.shift(),
      },
    } as any);
    const payloadPath = calls.find((c) => c.cmd === "gh" && c.args[1] === "-X")?.args.at(-1);
    expect(JSON.parse(readFileSync(payloadPath, "utf8")).event).toBe("REQUEST_CHANGES");
  });

  it("walkthrough fails closed when pinned diff hash is invalid", async () => {
    tempRoot();
    const s = sampleState("r", ["F1"]);
    s.snapshot.diffHash = "bad";
    restore({ sessionManager: { getBranch: () => [custom(s)] } } as any);
    const pi = extensionPi();
    const notes: string[] = [];
    let customCalls = 0;
    await pi.command("walkthrough", {
      mode: "tui",
      ui: { notify: (m: string) => notes.push(m), custom: async () => { customCalls += 1; } },
    } as any);
    expect(notes.at(-1)).toContain("hash_mismatch");
    expect(customCalls).toBe(0);
  });

  it("walkthrough blocks incomplete posting, supports cleanup, and switches only with child metadata", async () => {
    tempRoot();
    const incomplete = sampleState("r", []);
    mkdirSync(incomplete.snapshot.cache!.repoDir, { recursive: true });
    mkdirSync(incomplete.snapshot.cache!.worktree, { recursive: true });
    delete incomplete.plan;
    delete incomplete.result;
    restore({ sessionManager: { getBranch: () => [custom(incomplete)] } } as any);
    const pi = extensionPi();
    const intents = [{ kind: "post" }, { kind: "inspectChild" }, { kind: "cleanup" }, { kind: "cancel" }];
    await pi.command("walkthrough", {
      mode: "tui",
      ui: {
        notify() {},
        confirm: async () => true,
        select: async () => "COMMENT",
        custom: async (factory: any) => {
          const component = factory({ requestRender() {}, terminal: { rows: 20 } }, {}, { matches: () => false }, () => {});
          expect((component as any).options.viewModel.pages.map((p: any) => p.id)).toEqual(["overview", "finalize"]);
          return intents.shift();
        },
      },
      switchSession: async () => { throw new Error("should not switch"); },
    } as any);
    expect(pi.appended.at(-1)?.[1].state.cleaned).toBe(true);
  });

  it("walkthrough switches to child session when metadata exists", async () => {
    tempRoot();
    const s = sampleState("r", []);
    s.child = { sessionFile: "/tmp/child.jsonl", sessionName: "child" };
    restore({ sessionManager: { getBranch: () => [custom(s)] } } as any);
    const pi = extensionPi();
    let switched = "";
    await pi.command("walkthrough", {
      mode: "tui",
      ui: { notify() {}, custom: async () => ({ kind: "inspectChild" }) },
      switchSession: async (path: string) => { switched = path; return { cancelled: false }; },
    } as any);
    expect(switched).toBe("/tmp/child.jsonl");
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
    await pi.command("cleanup", { ui: { notify() {}, confirm: async () => true } } as any);
    await pi.command("cleanup", { ui: { notify() {}, confirm: async () => true } } as any);
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
