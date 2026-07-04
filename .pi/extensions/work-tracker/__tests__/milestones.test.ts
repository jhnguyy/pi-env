import { expect, it } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { formatTodoMilestoneLabel } from "../milestones";

describeIfEnabled("work-tracker", "todo milestones", () => {
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

  it("normalizes whitespace and caps label length", () => {
    const label = formatTodoMilestoneLabel([{ id: 1, text: `  ${"word ".repeat(40)}  ` }]);
    expect(label?.startsWith("todo: word word")).toBe(true);
    expect(label?.length).toBeLessThanOrEqual("todo: ".length + 80);
  });

  it("returns undefined without completed todos", () => {
    expect(formatTodoMilestoneLabel([])).toBeUndefined();
  });
});
