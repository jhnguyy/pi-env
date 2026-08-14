import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ReviewState } from "../core";
import {
  PrReviewWalkthroughComponent,
  deriveWalkthroughViewModel,
  type WalkthroughIntent,
} from "../walkthrough";

type ReviewFindings = NonNullable<ReviewState["result"]>["findings"];

function state(findings: ReviewFindings = [...baseFindings()]): ReviewState {
  return {
    snapshot: {
      id: "r1",
      artifactDir: "/tmp/a",
      worktree: "/tmp/w",
      diffPath: "/tmp/a/diff.patch",
      diffHash: "h",
      createdAt: "now",
      metadata: {
        owner: "acme",
        repo: "widgets",
        number: 7,
        url: "https://github.com/acme/widgets/pull/7",
        title: "add widgets",
        body: "body",
        baseOid: "base",
        headOid: "head1234567890",
        changedFiles: [{ path: "b.ts" }, { path: "a.ts" }, { path: "c.ts" }],
      },
    },
    plan: {
      goal: "ship widget support",
      goalAssessment: "clear",
      risk: "medium",
      riskReasons: ["touches parser"],
      cohorts: [
        { label: "parser", purpose: "check parsing", paths: ["a.ts", "c.ts"] },
        { label: "api", purpose: "check api", paths: ["b.ts"] },
      ],
      files: [
        { path: "b.ts", attention: "normal", role: "api" },
        { path: "a.ts", attention: "high", role: "parser" },
        { path: "c.ts", attention: "low", role: "docs" },
      ],
    },
    result: { verdict: "needs work", findings },
    selectedFindingIds: ["F1"],
    child: { sessionFile: "/tmp/session.jsonl", sessionName: "review child" },
    posts: [],
  };
}

function baseFindings() {
  return [
    {
      id: "F1",
      severity: "serious",
      impact: "high",
      file: "a.ts",
      side: "RIGHT",
      line: 10,
      problem: "parser drops escaped commas in a deliberately long explanation",
      consequence: "users lose data",
      suggestedFix: "preserve escapes",
      selected: true,
      anchorValid: true,
    },
    {
      id: "F2",
      severity: "medium",
      impact: "low",
      problem: "release note is missing",
      consequence: "operators miss the change",
      suggestedFix: "add a note",
      selected: false,
      anchorValid: false,
    },
    {
      id: "F3",
      severity: "low",
      impact: "low",
      problem: "migration note is missing",
      consequence: "admins guess",
      suggestedFix: "add migration note",
      selected: false,
      anchorValid: false,
    },
  ] as const;
}

const keyMap: Record<string, string> = {
  up: "tui.select.up",
  down: "tui.select.down",
  pageUp: "tui.select.pageUp",
  pageDown: "tui.select.pageDown",
  enter: "tui.select.confirm",
  escape: "tui.select.cancel",
};
function kb() {
  return { matches: (data: string, id: string) => keyMap[data] === id };
}
function text(component: PrReviewWalkthroughComponent, width: number): string {
  return component.render(width).join("\n");
}

describe("pr-review walkthrough", () => {
  it("derives pages in overview, cohort path, finding, unanchored, finalize order", () => {
    const vm = deriveWalkthroughViewModel(state(), {
      diffContextByFindingId: new Map([["F1", { lines: ["+value"] }]]),
    });
    expect(vm.pages.map((p) => p.id)).toEqual([
      "overview",
      "file:a.ts",
      "finding:F1",
      "file:c.ts",
      "file:b.ts",
      "unanchored",
      "finalize",
    ]);
    expect(vm.pages[0]?.lines.join("\n")).toContain("Goal assessment: clear");
    expect(vm.pages[0]?.lines.join("\n")).toContain("Reviewed head: head1234567890");
    expect(vm.pages.find((p) => p.id === "file:c.ts")?.lines.join("\n")).toContain(
      "Findings: none",
    );
    expect(vm.pages.find((p) => p.id === "finding:F1")?.lines.join("\n")).toContain("+value");
  });

  it("handles zero findings and missing child behavior", () => {
    const s = state([]);
    s.child = undefined;
    const vm = deriveWalkthroughViewModel(s);
    expect(vm.counts).toMatchObject({ anchoredFindings: 0, unanchoredFindings: 0 });
    expect(vm.pages.at(-1)?.lines.join("\n")).toContain("Child session: missing");
    expect(vm.pages.map((p) => p.id)).toEqual([
      "overview",
      "file:a.ts",
      "file:c.ts",
      "file:b.ts",
      "finalize",
    ]);
  });

  it("keeps unanchored and invalid anchored findings in result order with post-body explanation", () => {
    const findings = [...baseFindings(), { ...baseFindings()[0]!, id: "F4", anchorValid: false }];
    const vm = deriveWalkthroughViewModel(state(findings));
    const lines = vm.pages.find((p) => p.kind === "unanchored")?.lines.join("\n") ?? "";
    expect(lines.indexOf("F2")).toBeLessThan(lines.indexOf("F3"));
    expect(lines).toContain("F4");
    expect(lines).toContain("Post-body reason: no valid line is available in the pinned diff.");
  });

  it.each([39, 40, 60, 80, 120])("renders width-safe at %i columns", (width) => {
    const component = new PrReviewWalkthroughComponent({
      viewModel: deriveWalkthroughViewModel(state()),
      keybindings: kb(),
    });
    const lines = component.render(width);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    expect(text(component, width)).toContain(width < 40 ? "Resize to 40+" : "PR review");
    if (width < 40) expect(text(component, width)).toContain("/review findings");
  });

  it("bounds the viewport rows", () => {
    const component = new PrReviewWalkthroughComponent({
      viewModel: deriveWalkthroughViewModel(state()),
      keybindings: kb(),
      rows: 5,
    });
    expect(component.render(80)).toHaveLength(5);
  });

  it("keeps the header and action footer visible while wrapped content scrolls", () => {
    const longFinding = {
      ...baseFindings()[0]!,
      problem: "A long problem description ".repeat(30),
    };
    const component = new PrReviewWalkthroughComponent({
      viewModel: deriveWalkthroughViewModel(state([longFinding])),
      keybindings: kb(),
      rows: 12,
    });
    component.handleInput("\x1b[C");
    component.handleInput("\x1b[C");
    component.render(40);
    component.handleInput("pageDown");
    const lines = component.render(40);
    expect(lines[0]).toContain("PR review");
    expect(lines.at(-1)).toContain("section");
  });

  it("invalidates theme-sensitive render cache", () => {
    const theme = {
      fg: (_: string, s: string) => `\x1b[31m${s}\x1b[0m`,
      bold: (s: string) => `**${s}**`,
    };
    const component = new PrReviewWalkthroughComponent({
      viewModel: deriveWalkthroughViewModel(state()),
      keybindings: kb(),
      theme,
    });
    const before = component.render(80);
    component.invalidate();
    const after = component.render(80);
    expect(after).not.toBe(before);
    expect(component.themeInvalidationCount()).toBe(1);
  });

  it("keeps navigation and scrolling local and emits durable intents only", () => {
    const intents: WalkthroughIntent[] = [];
    const component = new PrReviewWalkthroughComponent({
      viewModel: deriveWalkthroughViewModel(state()),
      keybindings: kb(),
      onIntent: (intent) => intents.push(intent),
    });
    component.render(80);
    for (const key of ["down", "up", "pageDown", "pageUp", "\x1b[C", "\x1b[C"])
      component.handleInput(key);
    for (const key of [" ", "e", "f", "r", "p", "i", "c", "?", "escape"])
      component.handleInput(key);
    expect(intents.map((i) => i.kind)).toEqual([
      "toggleSelection",
      "edit",
      "editPreface",
      "rerun",
      "post",
      "inspectChild",
      "cleanup",
      "help",
      "cancel",
    ]);
  });

  it("makes Enter toggle on findings and request post on finalize", () => {
    const intents: WalkthroughIntent[] = [];
    const component = new PrReviewWalkthroughComponent({
      viewModel: deriveWalkthroughViewModel(state()),
      keybindings: kb(),
      onIntent: (intent) => intents.push(intent),
    });
    component.handleInput("\x1b[C");
    component.handleInput("\x1b[C");
    component.handleInput("enter");
    for (let i = 0; i < 4; i += 1) component.handleInput("\x1b[C");
    component.handleInput("enter");
    expect(intents).toMatchObject([{ kind: "toggleSelection", findingId: "F1" }, { kind: "post" }]);
  });
});
