import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as CodingAgent from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import reviewExtension, { clearInMemoryStateForTests } from "../index";
import { REVIEW_ENTRY_TYPE, sha256, type ReviewState } from "../core";
import { persistRawFindingArtifacts } from "../raw-provenance";
import type { AdmittedRawFinding } from "../schema";

const mocked = vi.hoisted(() => ({ agentDir: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...(await original<typeof CodingAgent>()),
  getAgentDir: () => mocked.agentDir,
}));

const temporaryRoots: string[] = [];
afterEach(() => {
  clearInMemoryStateForTests();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function reviewState(
  id: string,
  options: { degraded?: boolean; legacy?: boolean } = {},
): Promise<ReviewState> {
  const root = mocked.agentDir;
  const artifactDir = join(root, "pr-review", "artifacts", id);
  mkdirSync(artifactDir, { recursive: true });
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,2 @@",
    "-old",
    "+new pinned evidence",
    " context",
    "diff --git a/b.ts b/b.ts",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -1 +1 @@",
    "-before",
    "+after",
    "",
  ].join("\n");
  const diffPath = join(artifactDir, "diff.patch");
  writeFileSync(diffPath, diff);
  const findings = [
    {
      id: "F1",
      severity: "serious" as const,
      impact: "high" as const,
      file: "a.ts",
      side: "RIGHT" as const,
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
      severity: "medium" as const,
      impact: "medium" as const,
      problem: "problem two",
      consequence: "consequence two",
      suggestedFix: "fix two",
      selected: true,
      anchorValid: false,
      rawFindingIds: ["R-a2"],
    },
    {
      id: "F3",
      severity: "low" as const,
      impact: "low" as const,
      problem: "problem three",
      consequence: "consequence three",
      suggestedFix: "fix three",
      selected: true,
      anchorValid: false,
      rawFindingIds: ["R-a3"],
    },
    {
      id: "F4",
      severity: "low" as const,
      impact: "low" as const,
      problem: "problem four",
      consequence: "consequence four",
      suggestedFix: "fix four",
      selected: true,
      anchorValid: false,
      rawFindingIds: ["R-a4"],
    },
  ];
  const rawFindings: readonly AdmittedRawFinding[] = findings.map((finding, index) => ({
    id: `R-a${index + 1}`,
    role: "correctness",
    evidenceDigest: "d".repeat(64),
    finding: {
      severity: finding.severity,
      impact: finding.impact,
      ...(finding.file ? { file: finding.file, side: finding.side, line: finding.line } : {}),
      problem: `raw ${index + 1}`,
      consequence: finding.consequence,
      suggestedFix: finding.suggestedFix,
    },
  }));
  const rawRecords = options.legacy
    ? []
    : await Effect.runPromise(persistRawFindingArtifacts(artifactDir, `${id}-run`, rawFindings));
  return {
    snapshot: {
      id,
      artifactDir,
      worktree: join(root, "pr-review", "worktrees", id),
      diffPath,
      diffHash: sha256(diff),
      createdAt: id,
      metadata: {
        owner: "o",
        repo: "r",
        number: id === "older" ? 1 : 2,
        url: `https://github.com/o/r/pull/${id === "older" ? 1 : 2}`,
        baseOid: "base",
        headOid: `${id}-head`,
        changedFiles: [{ path: "a.ts" }, { path: "b.ts" }],
      },
    },
    dag: {
      runId: `${id}-run`,
      ...(!options.legacy ? { synthesisProtocol: 2 as const } : {}),
      status: options.degraded ? "degraded" : "succeeded",
      rawResultReferences: [],
      evidenceCoverage: {
        digest: "d".repeat(64),
        uniqueBytes: 20,
        dossierBytes: 20,
        chunks: 1,
        omissions: options.degraded ? ["b.ts hunk was omitted"] : [],
      },
      failedNodes: options.degraded ? ["review-security"] : [],
      malformedNodes: [],
    },
    plan: {
      goal: "goal",
      goalAssessment: "assessment",
      risk: "risk",
      riskReasons: [],
      cohorts: [{ label: "all", purpose: "ordered inspection", paths: ["a.ts", "b.ts"] }],
      files: [
        { path: "a.ts", attention: "high", role: "core behavior" },
        { path: "b.ts", attention: "normal", role: "supporting behavior" },
      ],
      evidence: [{ kind: "diff", path: "a.ts", startLine: 1, endLine: 2, purpose: "change" }],
      evidenceOmissions: options.degraded ? ["b.ts hunk was omitted"] : [],
    },
    result: {
      verdict: options.degraded ? "partial" : "complete",
      coverage: {
        status: options.degraded ? "degraded" : "complete",
        succeeded: ["correctness"],
        failed: options.degraded ? ["security"] : [],
        malformed: [],
      },
      findings,
      ...(options.legacy
        ? {}
        : {
            provenance: {
              v: 2 as const,
              kind: "editorial-consolidation" as const,
              status: options.degraded ? ("fallback" as const) : ("accepted" as const),
              rawFindings: rawRecords,
              dismissals: [],
              ...(options.degraded ? { fallbackReason: "invalid consolidation" } : {}),
            },
          }),
    },
    selectedFindingIds: ["F1", "F2", "F3", "F4"],
    ...(options.legacy ? {} : { decisions: {} }),
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

async function harness(states: readonly { id: string; degraded?: boolean; legacy?: boolean }[]) {
  mocked.agentDir = mkdtempSync(join(tmpdir(), "review-walkthrough-"));
  temporaryRoots.push(mocked.agentDir);
  const fixtures = await Promise.all(states.map((state) => reviewState(state.id, state)));
  const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
  const handlers: Record<string, (event: unknown, ctx: unknown) => void> = {};
  const appended: Array<{ reviewId: string; state: ReviewState }> = [];
  const pi = {
    events: { on: () => () => {}, emit() {} },
    registerTool() {},
    registerCommand(name: string, command: (typeof commands)[string]) {
      commands[name] = command;
    },
    on(name: string, handler: (event: unknown, ctx: unknown) => void) {
      handlers[name] = handler;
    },
    appendEntry(_type: string, data: { reviewId: string; state: ReviewState }) {
      appended.push(structuredClone(data));
    },
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  reviewExtension(pi as never);
  const branch = fixtures.map(entry);
  const session = (id: string, entries = branch) => ({
    cwd: mocked.agentDir,
    hasUI: true,
    sessionManager: {
      getSessionId: () => id,
      getSessionDir: () => mocked.agentDir,
      getBranch: () => entries,
    },
    modelRegistry: { getAvailable: () => [] },
  });
  handlers.session_start?.({}, session("session-a"));
  return { pi, command: commands.review.handler, handlers, appended, fixtures, session };
}

function notifications(hasUI = true) {
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
        confirm: async () => false,
      },
    },
  };
}

describe("registered review walkthrough boundary", () => {
  it("targets the explicit review and durably preserves four statuses distinct from defaults", async () => {
    const { command, appended, fixtures, handlers, session } = await harness([
      { id: "older" },
      { id: "newer" },
    ]);
    const newerBefore = structuredClone(fixtures[1]);
    const { ctx, notes } = notifications();
    await command("pr select older F1", ctx);
    await command("pr reject older F2", ctx);
    await command("pr defer older F3", ctx);
    expect(appended.at(-1)?.state.decisions).toMatchObject({
      F1: { status: "selected" },
      F2: { status: "rejected" },
      F3: { status: "deferred" },
    });
    expect(appended.at(-1)?.state.decisions?.F4).toBeUndefined();
    expect(appended.at(-1)?.state.selectedFindingIds).toEqual(["F1"]);
    expect(appended.every((data) => data.reviewId === "older")).toBe(true);
    expect(fixtures[1]).toEqual(newerBefore);
    const newerView = notifications(false);
    await command("pr walkthrough newer", newerView.ctx);
    expect(newerView.notes.at(-1)).toContain("F1 [pending] recommended");
    expect(newerView.notes.at(-1)).not.toContain("[selected]");

    const appendCount = appended.length;
    await command("pr select", ctx);
    await command("pr reject missing F1", ctx);
    await command("pr defer older unknown", ctx);
    expect(appended).toHaveLength(appendCount);
    expect(notes.join("\n")).toContain("explicit review ID");
    expect(notes.join("\n")).toContain("Review not found: missing");
    expect(notes.join("\n")).toContain("not owned by review older");

    const replay = [
      ...fixtures.map(entry),
      ...appended.map((data) => ({ type: "custom", customType: REVIEW_ENTRY_TYPE, data })),
    ];
    clearInMemoryStateForTests();
    handlers.session_tree?.({}, session("session-a", replay));
    const restored = notifications(false);
    await command("pr walkthrough older", restored.ctx);
    expect(restored.notes.at(-1)).toContain("F1 [selected]");
    expect(restored.notes.at(-1)).toContain("F2 [rejected]");
    expect(restored.notes.at(-1)).toContain("F3 [deferred]");
    expect(restored.notes.at(-1)).toContain("F4 [pending] recommended");
  });

  it("guides ordered file inspection to hash-verified pinned diff evidence", async () => {
    const { command, fixtures } = await harness([{ id: "older" }]);
    const selections = [
      "2. Reading plan and pinned file diffs",
      "1. a.ts [high] - core behavior",
      "Pinned diff page 1/1",
      "Back",
      "Back",
      "Back",
      "Exit walkthrough",
    ];
    const titles: string[] = [];
    const notes: string[] = [];
    await command("pr walkthrough older", {
      hasUI: true,
      cwd: mocked.agentDir,
      ui: {
        notify: (message: string) => notes.push(message),
        select: async (title: string) => {
          titles.push(title);
          return selections.shift();
        },
        editor: async () => undefined,
        confirm: async () => false,
      },
    });
    expect(titles[0]).toContain("Choose a stage");
    expect(titles.join("\n")).toContain("Reading plan: 2 ordered file(s)");
    expect(titles.join("\n")).toContain("Pinned diff is hash verified");
    expect(titles.join("\n")).toContain("new pinned evidence");
    expect(notes.at(-1)).toContain("Anchored findings");

    writeFileSync(fixtures[0].snapshot.diffPath, "live or tampered replacement");
    const tamperedChoices = [
      "2. Reading plan and pinned file diffs",
      "1. a.ts [high] - core behavior",
    ];
    await command("pr walkthrough older", {
      hasUI: true,
      cwd: mocked.agentDir,
      ui: {
        notify: (message: string) => notes.push(message),
        select: async () => tamperedChoices.shift(),
        editor: async () => undefined,
        confirm: async () => false,
      },
    });
    expect(notes.at(-1)).toContain("Pinned diff integrity check failed");
    expect(notes.at(-1)).not.toContain("live or tampered replacement");
  });

  it("shows verified original provenance after an edit and refuses tampered raw evidence", async () => {
    const { command, appended, fixtures } = await harness([{ id: "older" }]);
    const beforeRaw = structuredClone(fixtures[0].result?.provenance?.rawFindings);
    const notes: string[] = [];
    await command("pr select older F2", notifications().ctx);
    await command("pr edit older F1", {
      hasUI: true,
      ui: {
        notify: (message: string) => notes.push(message),
        editor: async () =>
          "Problem: edited\nConsequence: edited consequence\nSuggested fix: edited fix",
      },
    });
    const edited = appended.at(-1)!.state;
    expect(edited.result?.findings[0]).toMatchObject({
      problem: "edited",
      severity: "serious",
      rawFindingIds: ["R-a1"],
    });
    expect(edited.result?.provenance?.rawFindings).toEqual(beforeRaw);
    expect(edited.decisions?.F2.status).toBe("selected");

    const inspectRaw = async () => {
      const selections = [
        "5. Provenance and dispositions",
        "Raw 1: R-a1 [correctness]",
        "Back",
        "Back",
        "Exit walkthrough",
      ];
      const titles: string[] = [];
      await command("pr walkthrough older", {
        hasUI: true,
        cwd: mocked.agentDir,
        ui: {
          notify: (message: string) => notes.push(message),
          select: async (title: string) => {
            titles.push(title);
            return selections.shift();
          },
          editor: async () => undefined,
          confirm: async () => false,
        },
      });
      return titles.join("\n");
    };
    const validRawView = await inspectRaw();
    expect(validRawView).toContain('"problem": "raw 1"');
    expect(validRawView).not.toContain('"problem": "edited"');

    const firstRaw = beforeRaw?.[0];
    if (!firstRaw) throw new Error("Expected a persisted raw finding fixture.");
    writeFileSync(
      join(fixtures[0].snapshot.artifactDir, firstRaw.artifact.path),
      "tampered raw source",
    );
    const tamperedRawView = await inspectRaw();
    expect(tamperedRawView).toContain("Raw evidence unavailable or tampered");
    expect(tamperedRawView).not.toContain("tampered raw source");

    const count = appended.length;
    await command("pr edit older F1", {
      hasUI: true,
      ui: { notify: (message: string) => notes.push(message), editor: async () => undefined },
    });
    expect(appended).toHaveLength(count);
    expect(notes).toContain("Edit cancelled.");
  });

  it("rejects changed degraded acknowledgement and then finalizes without quorum or posting", async () => {
    const { command, appended } = await harness([{ id: "older", degraded: true }]);
    const notes: string[] = [];
    let changed = false;
    const ctx = {
      hasUI: true,
      cwd: mocked.agentDir,
      ui: {
        notify: (message: string) => notes.push(message),
        confirm: async () => {
          if (!changed) {
            changed = true;
            await command("pr defer older F2", notifications().ctx);
          }
          return true;
        },
      },
    };
    await command("pr finalize older", ctx);
    expect(notes.at(-1)).toContain("changed during acknowledgement");
    expect(appended.at(-1)?.state.finalizedAt).toBeUndefined();
    await command("pr finalize older", ctx);
    expect(notes.at(-1)).toContain("Next: /review pr post older comment");
    expect(appended.at(-1)?.state.degradationAcknowledgement).toBeDefined();
    expect(appended.at(-1)?.state.finalizedAt).toBeDefined();
    expect(appended.at(-1)?.state.posts).toEqual([]);
  });

  it("keeps headless walkthrough read-only and rejects a stale editor generation", async () => {
    const { command, appended, handlers, session, fixtures } = await harness([{ id: "older" }]);
    const headless = notifications(false);
    await command("pr walkthrough older", headless.ctx);
    expect(headless.notes.at(-1)).toContain("Interactive decisions and finalization unavailable");
    expect(appended).toHaveLength(0);
    await command("pr edit older F1", headless.ctx);
    expect(headless.notes.at(-1)).toContain("requires interactive editor UI");
    expect(appended).toHaveLength(0);

    let release!: (value: string) => void;
    const editor = new Promise<string>((resolve) => {
      release = resolve;
    });
    const stale = command("pr edit older F1", {
      hasUI: true,
      ui: { notify: (message: string) => headless.notes.push(message), editor: async () => editor },
    });
    await Promise.resolve();
    handlers.session_tree?.({}, session("session-b", fixtures.map(entry)));
    release("Problem: stale\nConsequence: stale\nSuggested fix: stale");
    await stale;
    expect(headless.notes.at(-1)).toContain("session changed");
    expect(appended).toHaveLength(0);
  });
});
