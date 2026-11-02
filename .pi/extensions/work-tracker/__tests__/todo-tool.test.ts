import { describe, expect, it } from "vitest";
import { TodoStore } from "../store";
import { executeTodo, TodoAction } from "../todo-tool";

describe("todo tool", () => {
  it("summarizes add results without echoing task text", () => {
    const store = new TodoStore();
    const result = executeTodo(store, {
      action: TodoAction.Add,
      text: ["first verbose task", "second verbose task"],
    });

    expect(result.content[0].text).toBe("Added 2 tasks: ids 1, 2.");
    expect(store.open().map(({ id, text }) => ({ id, text }))).toEqual([
      { id: 1, text: "first verbose task" },
      { id: 2, text: "second verbose task" },
    ]);
    expect(result.details).toEqual({ ids: [1, 2] });
  });

  it("keeps explicit list output detailed", () => {
    const store = new TodoStore();
    executeTodo(store, { action: TodoAction.Add, text: ["keep full list available"] });

    const result = executeTodo(store, { action: TodoAction.List });

    expect(result.content[0].text).toContain("□ (1) keep full list available");
  });
});
