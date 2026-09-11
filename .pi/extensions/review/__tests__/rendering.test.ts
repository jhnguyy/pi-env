import "../../__tests__/tui-setup";
import { describe, expect, it } from "vitest";
import { reviewActionResult, reviewProgressResult, withoutNestedUsage } from "../index";
import { projectReviewProgress, renderReviewResult } from "../render";

const recordingTheme = {
  fg: (style: string, text: string) => `<${style}>${text}</${style}>`,
  bold: (text: string) => `<bold>${text}</bold>`,
};

function textOf(component: unknown): string {
  return (component as { text: string }).text;
}

describe("review tool rendering", () => {
  it("shows a bounded one-line verdict, zero cost, and the exact review ID without usage counters", () => {
    const reviewId = "review-a1-review-a10";
    const verdict = `${"v".repeat(40)}\n${"w".repeat(40)} full verdict tail`;
    const result = {
      content: [
        {
          type: "text" as const,
          text: `Detailed result\nturns=991 input=992 output=993 cache=994\n${verdict}`,
        },
      ],
      details: {
        status: "succeeded",
        reviewId,
        verdict,
        metrics: {
          usage: {
            cost: 0,
            turns: 991,
            input: 992,
            output: 993,
            cacheRead: 994,
            cacheWrite: 995,
          },
        },
      },
    };

    const collapsed = textOf(
      renderReviewResult(result, { expanded: false, isPartial: false }, recordingTheme),
    );
    const verdictLine = collapsed.split("\n").find((line) => line.includes("verdict:"));

    expect(verdictLine).toContain(`verdict: ${"v".repeat(40)} ${"w".repeat(29)}...`);
    expect(verdictLine).not.toContain("full verdict tail");
    expect(collapsed).toContain("cost: $0.0000");
    expect(collapsed).toContain(reviewId);
    expect(collapsed).not.toMatch(/991|992|993|994|995/);
  });

  it("keeps the complete verdict and existing detailed result when expanded", () => {
    const verdict = "first verdict line\nsecond verdict line";
    const detailed = "Existing detailed result with findings and coverage.";
    const expanded = textOf(
      renderReviewResult(
        {
          content: [{ type: "text" as const, text: detailed }],
          details: {
            status: "degraded",
            reviewId: "review-expanded",
            verdict,
            metrics: { usage: { cost: 1.25 } },
          },
        },
        { expanded: true, isPartial: false },
        recordingTheme,
      ),
    );

    expect(expanded).toContain(verdict);
    expect(expanded).toContain(detailed);
    expect(expanded).toContain("$1.2500");
    expect(expanded).toContain("review-expanded");
    expect(expanded).toContain("<warning>⚠</warning>");
  });

  it.each([
    ["succeeded", "<success>✓</success>"],
    ["degraded", "<warning>⚠</warning>"],
    ["interrupted", "<warning>⚠</warning>"],
    ["cancelled", "<warning>⚠</warning>"],
    ["failed", "<error>✗</error>"],
  ])("uses the required terminal icon for %s reviews", (status, icon) => {
    const rendered = textOf(
      renderReviewResult(
        {
          content: [{ type: "text" as const, text: "terminal result" }],
          details: { status, reviewId: `review-${status}` },
          ...(status === "failed" ? { isError: true } : {}),
        },
        { expanded: false, isPartial: false },
        recordingTheme,
      ),
    );

    expect(rendered).toContain(icon);
    if (["failed", "interrupted", "cancelled"].includes(status)) {
      expect(rendered).toContain("verdict: unavailable");
    }
  });

  it("labels persisted spend when an idempotent review is reused", () => {
    const rendered = textOf(
      renderReviewResult(
        {
          content: [{ type: "text" as const, text: "recorded result" }],
          details: {
            status: "succeeded",
            reviewId: "review-reused",
            verdict: "recorded verdict",
            reused: true,
            metrics: { usage: { cost: 0.25 } },
          },
        },
        { expanded: false, isPartial: false },
        recordingTheme,
      ),
    );

    expect(rendered).toContain("recorded cost: $0.2500");
    expect(rendered).not.toContain("  cost:");
  });

  it("maps completed, active, and queued phases to their required theme roles", () => {
    const details = {
      status: "running",
      reviewId: "review-progress",
      runId: "run-progress",
      nodes: {
        "reading-plan": "succeeded",
        "evidence-resolver": "succeeded",
        "review-correctness": "succeeded",
        "review-intent": "running",
        "review-maintainability": "queued",
        "review-tests": "running",
        "review-security": "queued",
        "review-whole-change": "queued",
        synthesis: "queued",
      },
      usage: { cost: 0.1621 },
    };
    const rendered = textOf(
      renderReviewResult(
        { content: [], details },
        { expanded: false, isPartial: true },
        recordingTheme,
      ),
    );

    expect(rendered).toContain("<success>planning ✓</success>");
    expect(rendered).toContain("<warning>reviewing intent, tests</warning>");
    expect(rendered).toContain("<dim>synthesizing ○</dim>");
    expect(rendered).toContain("<muted> → </muted>");
    expect(rendered).toContain("cost: $0.1621");
    expect(rendered).toContain("review-progress");
  });

  it("keeps running reviewer roles visible when a sibling already failed", () => {
    const rendered = textOf(
      renderReviewResult(
        {
          content: [],
          details: {
            status: "running",
            reviewId: "review-mixed-terminal",
            nodes: {
              "reading-plan": "succeeded",
              "evidence-resolver": "succeeded",
              "review-correctness": "failed",
              "review-intent": "running",
              "review-tests": "running",
              synthesis: "queued",
            },
          },
        },
        { expanded: false, isPartial: true },
        recordingTheme,
      ),
    );

    expect(rendered).toContain("<warning>reviewing intent, tests</warning>");
    expect(rendered).toContain("<error>[correctness failed]</error>");
    expect(rendered).not.toContain("<success>reviewing");
  });

  it("preserves failed and interrupted phases instead of marking them complete", () => {
    const phases = projectReviewProgress({
      "reading-plan": "failed",
      "evidence-resolver": "blocked",
      "review-correctness": "interrupted",
      "review-intent": "cancelled",
      synthesis: "queued",
    });

    expect(phases[0]).toMatchObject({ label: "planning", status: "failed" });
    expect(phases[1]).toMatchObject({ label: "reviewing", status: "interrupted" });
    expect(phases[0]?.status).not.toBe("complete");
    expect(phases[1]?.status).not.toBe("complete");
  });

  it("reports terminal nested usage once and omits it for duplicate or persisted reuse results", () => {
    const state = {
      snapshot: { id: "review-terminal-usage" },
      dag: { status: "succeeded" },
      result: { verdict: "complete", findings: [] },
      metrics: {
        durationMs: 1,
        deckBytes: 2,
        reviewerOutputBytes: 3,
        reviewersSucceeded: 6,
        reviewersFailed: 0,
        reviewersMalformed: 0,
        findings: 0,
        anchoredFindings: 0,
        usage: {
          input: 11,
          output: 12,
          cacheRead: 13,
          cacheWrite: 14,
          cost: 1.5,
          turns: 6,
        },
      },
      selectedFindingIds: [],
      posts: [],
    } as never;

    const terminal = reviewActionResult(state);
    expect(terminal.usage).toMatchObject({
      input: 11,
      output: 12,
      cacheRead: 13,
      cacheWrite: 14,
      cost: { total: 1.5 },
    });
    expect(Object.hasOwn(withoutNestedUsage(terminal), "usage")).toBe(false);
    expect(Object.hasOwn(reviewActionResult(state, true), "usage")).toBe(false);
  });

  it("keeps cumulative child usage in partial details and out of top-level accounting", () => {
    const usage = {
      input: 101,
      output: 102,
      cacheRead: 103,
      cacheWrite: 104,
      cost: 1.2345,
      turns: 105,
    };
    const partial = reviewProgressResult({
      reviewId: "review-usage",
      runId: "run-usage",
      nodes: { "reading-plan": "running" },
      usage,
    });

    expect(partial.details.usage).toEqual(usage);
    expect(Object.hasOwn(partial, "usage")).toBe(false);
  });
});
