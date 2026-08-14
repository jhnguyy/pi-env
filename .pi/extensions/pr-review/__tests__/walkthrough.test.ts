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

  it("keeps unanchored findings in result order with post-body explanation", () => {
    const vm = deriveWalkthroughViewModel(state());
    const lines = vm.pages.find((p) => p.kind === "unanchored")?.lines.join("\n") ?? "";
    expect(lines.indexOf("F2")).toBeLessThan(lines.indexOf("F3"));
    expect(lines).toContain("Post-body explanation");
  });

  it.each([39, 40, 60, 80, 120])("renders width-safe at %i columns", (width) => {
    const component = new PrReviewWalkthroughComponent({
      viewModel: deriveWalkthroughViewModel(state()),
      keybindings: kb(),
    });
    const lines = component.render(width);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    expect(text(component, width)).toContain(width < 40 ? "Width too narrow" : "PR review");
  });

  it("bounds the viewport rows", () => {
    const component = new PrReviewWalkthroughComponent({
      viewModel: deriveWalkthroughViewModel(state()),
      keybindings: kb(),
      rows: 5,
    });
    expect(component.render(80)).toHaveLength(5);
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

  it("maps standard and local keys to intents only", () => {
    const intents: WalkthroughIntent[] = [];
    const component = new PrReviewWalkthroughComponent({
      viewModel: deriveWalkthroughViewModel(state()),
      keybindings: kb(),
      onIntent: (intent) => intents.push(intent),
    });
    for (const key of ["down", "up", "pageDown", "pageUp", "enter", "escape"])
      component.handleInput(key);
    component.handleInput("down");
    component.handleInput("down");
    for (const key of [" ", "e", "r", "p", "i", "c", "?"]) component.handleInput(key);
    expect(intents.map((i) => i.kind)).toEqual([
      "navigate",
      "navigate",
      "navigate",
      "navigate",
      "confirm",
      "cancel",
      "navigate",
      "navigate",
      "toggleSelection",
      "edit",
      "rerun",
      "post",
      "inspectChild",
      "copy",
      "help",
    ]);
  });
});
