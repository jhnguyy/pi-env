import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as CodingAgent from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import reviewExtension, { clearInMemoryStateForTests } from "../index";
import { REVIEW_ENTRY_TYPE, sha256, type ReviewState } from "../core";

const mocked = vi.hoisted(() => ({ agentDir: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...(await original<typeof CodingAgent>()),
  getAgentDir: () => mocked.agentDir,
}));
const roots: string[] = [];
afterEach(() => {
  clearInMemoryStateForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function reviewState(id: string): ReviewState {
  const artifactDir = join(mocked.agentDir, "pr-review", "artifacts", id);
  mkdirSync(artifactDir, { recursive: true });
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new pinned evidence",
    "diff --git a/b.ts b/b.ts",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -1 +1 @@",
    "-before",
    "+after",
  ].join("\n");
  const diffPath = join(artifactDir, "diff.patch");
  writeFileSync(diffPath, diff);
  const reviewerArtifact = {
    v: 1 as const,
    path: "review-correctness/result.json",
    bytes: 10,
    digest: "a".repeat(64),
    runId: `${id}-run`,
    producerNodeId: "review-correctness",
    outputName: "correctness_review",
  };
  return {
    snapshot: {
      id,
      artifactDir,
      worktree: join(mocked.agentDir, "pr-review", "worktrees", id),
      diffPath,
      diffHash: sha256(diff),
      createdAt: id,
      metadata: {
        owner: "o",
        repo: "r",
        number: 1,
        url: "https://github.com/o/r/pull/1",
        baseOid: "base",
        headOid: `${id}-head`,
        changedFiles: [{ path: "a.ts" }, { path: "b.ts" }],
      },
    },
    dag: {
      runId: `${id}-run`,
      synthesisProtocol: 2,
      status: "succeeded",
      rawResultReferences: [reviewerArtifact],
      evidenceCoverage: {
        digest: "d".repeat(64),
        uniqueBytes: 20,
        dossierBytes: 20,
        chunks: 1,
        omissions: [],
      },
    },
    plan: {
      goal: "goal",
      goalAssessment: "assessment",
      risk: "risk",
      riskReasons: [],
      cohorts: [{ label: "all", purpose: "inspection", paths: ["a.ts", "b.ts"] }],
      files: [
        { path: "a.ts", attention: "high", role: "core behavior" },
        { path: "b.ts", attention: "normal", role: "supporting behavior" },
      ],
      evidence: [{ kind: "diff", path: "a.ts", startLine: 1, endLine: 1, purpose: "change" }],
    },
    result: {
      verdict: "complete",
      coverage: {
        status: "complete",
        succeeded: ["correctness"],
        failed: [],
        malformed: [],
      },
      findings: [
        {
          id: "F1",
          severity: "serious",
          impact: "high",
          file: "a.ts",
          side: "RIGHT",
          line: 1,
          problem: "problem one",
          consequence: "consequence one",
          suggestedFix: "fix one",
          selected: true,
          anchorValid: true,
          rawFindingIds: ["R-a1"],
        },
        {
          id: "F2",
          severity: "medium",
          impact: "medium",
          problem: "problem two",
          consequence: "consequence two",
          suggestedFix: "fix two",
          selected: true,
          anchorValid: false,
          rawFindingIds: ["R-a2"],
        },
      ],
      provenance: {
        v: 2,
        kind: "editorial-consolidation",
        status: "accepted",
        rawFindings: [0, 1].map((index) => ({
          id: `R-a${index + 1}`,
          role: "correctness" as const,
          evidenceDigest: "d".repeat(64),
          index,
          artifact: reviewerArtifact,
        })),
        dismissals: [],
      },
    },
    selectedFindingIds: ["F1", "F2"],
    decisions: {},
    posts: [],
  };
}
function entry(state: ReviewState) {
  return {
    type: "custom",
    customType: REVIEW_ENTRY_TYPE,
    data: { reviewId: state.snapshot.id, state },
  };
}
async function harness() {
  mocked.agentDir = mkdtempSync(join(tmpdir(), "review-walkthrough-"));
  roots.push(mocked.agentDir);
  const fixtures = [reviewState("older"), reviewState("newer")];
  const commands: Record<string, any> = {};
  const handlers: Record<string, any> = {};
  const appended: Array<{ reviewId: string; state: ReviewState }> = [];
  const pi = {
    events: { on: () => () => {} },
    registerTool() {},
    registerCommand(name: string, command: unknown) {
      commands[name] = command;
    },
    on(name: string, handler: unknown) {
      handlers[name] = handler;
    },
    appendEntry(_type: string, data: { reviewId: string; state: ReviewState }) {
      appended.push(structuredClone(data));
    },
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  reviewExtension(pi as never);
  const session = (id: string, states = fixtures) => ({
    cwd: mocked.agentDir,
    hasUI: true,
    sessionManager: {
      getSessionId: () => id,
      getSessionDir: () => mocked.agentDir,
      getBranch: () => states.map(entry),
    },
    modelRegistry: { getAvailable: () => [] },
  });
  handlers.session_start({}, session("session-a"));
  return { command: commands.review.handler, handlers, appended, fixtures, session };
}
function context(hasUI = true) {
  const notes: string[] = [];
  return {
    notes,
    ctx: {
      hasUI,
      cwd: mocked.agentDir,
      ui: {
        notify: (message: string) => notes.push(message),
        select: async () => undefined,
        editor: async () => undefined,
      },
    },
  };
}

describe("registered review walkthrough boundary", () => {
  it("persists explicit-ID decisions and keeps defaults pending after reconstruction", async () => {
    const { command, appended, handlers, fixtures, session } = await harness();
    const view = context();
    await command("pr select older F1", view.ctx);
    await command("pr reject older F2", view.ctx);
    expect(appended.at(-1)?.state.decisions).toMatchObject({
      F1: { status: "selected" },
      F2: { status: "rejected" },
    });
    expect(appended.at(-1)?.state.selectedFindingIds).toEqual(["F1"]);
    const count = appended.length;
    await command("pr defer older unknown", view.ctx);
    expect(appended).toHaveLength(count);

    handlers.session_tree(
      {},
      session("session-a", [fixtures[0], ...appended.map((item) => item.state)]),
    );
    const restored = context(false);
    await command("pr walkthrough older", restored.ctx);
    expect(restored.notes.at(-1)).toContain("F1 [selected]");
    expect(restored.notes.at(-1)).toContain("F2 [rejected]");
  });

  it("navigates every planned file using only hash-verified pinned evidence", async () => {
    const { command, fixtures } = await harness();
    const choices = ["Reading plan", "2. b.ts [normal] - supporting behavior", "Back", "Exit"];
    const shown: string[] = [];
    const notes: string[] = [];
    await command("pr walkthrough older", {
      hasUI: true,
      cwd: mocked.agentDir,
      ui: {
        notify: (message: string) => notes.push(message),
        select: async (title: string) => {
          shown.push(title);
          return choices.shift();
        },
      },
    });
    expect(shown.join("\n")).toContain("b.ts");
    expect(shown.join("\n")).toContain("Pinned diff is hash verified");
    expect(shown.join("\n")).toContain("+after");

    writeFileSync(fixtures[0].snapshot.diffPath, "tampered worktree-like content");
    const tampered = ["Reading plan", "1. a.ts [high] - core behavior"];
    await command("pr walkthrough older", {
      hasUI: true,
      cwd: mocked.agentDir,
      ui: { notify: (message: string) => notes.push(message), select: async () => tampered.shift() },
    });
    expect(notes.at(-1)).toContain("Pinned diff integrity check failed");
    expect(notes.at(-1)).not.toContain("worktree-like content");
  });

  it("preserves finding identity and provenance while editing", async () => {
    const { command, appended, fixtures } = await harness();
    const before = structuredClone(fixtures[0].result?.provenance);
    const notes: string[] = [];
    await command("pr edit older F1", {
      hasUI: true,
      ui: {
        notify: (message: string) => notes.push(message),
        editor: async () =>
          "Problem: edited\nConsequence: edited consequence\nSuggested fix: edited fix",
      },
    });
    expect(appended.at(-1)?.state.result?.findings[0]).toMatchObject({
      id: "F1",
      problem: "edited",
      rawFindingIds: ["R-a1"],
    });
    expect(appended.at(-1)?.state.result?.provenance).toEqual(before);
  });

  it("keeps headless walkthrough read-only and invalidates stale editor actions", async () => {
    const { command, appended, handlers, fixtures, session } = await harness();
    const headless = context(false);
    await command("pr walkthrough older", headless.ctx);
    expect(headless.notes.at(-1)).toContain("Interactive decisions unavailable");
    expect(appended).toHaveLength(0);

    let release!: (value: string) => void;
    const editing = command("pr edit older F1", {
      hasUI: true,
      ui: {
        notify: (message: string) => headless.notes.push(message),
        editor: () => new Promise<string>((resolve) => (release = resolve)),
      },
    });
    await Promise.resolve();
    handlers.session_tree({}, session("session-b", fixtures));
    release("Problem: stale\nConsequence: stale\nSuggested fix: stale");
    await editing;
    expect(headless.notes.at(-1)).toContain("session changed");
    expect(appended).toHaveLength(0);

    handlers.session_tree({}, session("session-a", fixtures));
    const choices = ["Provenance", "R-a1 [correctness] #0"];
    await command("pr walkthrough older", {
      hasUI: true,
      cwd: mocked.agentDir,
      sessionManager: session("session-a").sessionManager,
      ui: {
        notify: (message: string) => headless.notes.push(message),
        select: async () => {
          const choice = choices.shift();
          if (choice?.startsWith("R-"))
            queueMicrotask(() => handlers.session_tree({}, session("session-b", fixtures)));
          return choice;
        },
      },
    });
    expect(headless.notes.at(-1)).toContain("session changed");
    expect(headless.notes.at(-1)).not.toContain("Raw evidence unavailable");
  });
});
