import { describe, expect, it } from "vitest";
import { formatTodoMilestoneLabel } from "../milestones";

describe("todo milestones", () => {
  it("formats a single completed todo as a session label", () => {
    expect(formatTodoMilestoneLabel([{ id: 1, text: "Implement session navigation" }])).toBe(
      "todo: Implement session navigation",
    );
  });

  it("summarizes multiple completed todos", () => {
    expect(formatTodoMilestoneLabel([
      { id: 1, text: "Implement session navigation" },
      { id: 2, text: "Add tests" },
    ])).toBe("todo: Implement session navigation +1");
  });

  it("collapses whitespace in the completed task label", () => {
    expect(formatTodoMilestoneLabel([{ id: 1, text: " \tfirst\n second  " }]))
      .toBe("todo: first second");
  });

  it("limits the task portion of the label to 80 characters", () => {
    expect(formatTodoMilestoneLabel([{ id: 1, text: "x".repeat(81) }]))
      .toBe(`todo: ${"x".repeat(80)}`);
  });

  it("returns undefined without completed todos", () => {
    expect(formatTodoMilestoneLabel([])).toBeUndefined();
  });
});
