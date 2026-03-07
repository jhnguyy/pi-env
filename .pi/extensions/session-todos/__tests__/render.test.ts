import { describe, it, expect, beforeEach } from "bun:test";
import { TodoStore } from "../store";

describe("render()", () => {
  let store: TodoStore;

  beforeEach(() => {
    store = new TodoStore();
  });

  it("renders empty state correctly", () => {
    expect(store.render()).toBe("[session-todos] No tasks yet.");
  });

  it("renders a single open task", () => {
    store.add("slim work-tracker extension");
    const out = store.render();
    expect(out).toBe("[session-todos]\n□ (1) slim work-tracker extension");
  });

  it("renders mixed open/done list correctly", () => {
    store.add("slim work-tracker extension");
    store.add("fix LSP socket paths");
    store.add("update vault note");
    store.complete(1);
    store.complete(2);
    const out = store.render();
    const lines = out.split("\n");
    expect(lines[0]).toBe("[session-todos]");
    expect(lines[1]).toBe("✅ (1) slim work-tracker extension");
    expect(lines[2]).toBe("✅ (2) fix LSP socket paths");
    expect(lines[3]).toBe("□ (3) update vault note");
  });

  it("ids are stable after remove — no renumbering", () => {
    store.add("task one");
    store.add("task two");
    store.add("task three");
    store.remove(2);
    const out = store.render();
    const lines = out.split("\n");
    expect(lines[1]).toBe("□ (1) task one");
    expect(lines[2]).toBe("□ (3) task three");
    expect(lines).toHaveLength(3); // header + 2 tasks
  });

  it("renders header on first line when tasks exist", () => {
    store.add("some task");
    const out = store.render();
    expect(out.split("\n")[0]).toBe("[session-todos]");
  });

  it("doesn't include header in empty state", () => {
    const out = store.render();
    expect(out).not.toContain("\n");
    expect(out).toBe("[session-todos] No tasks yet.");
  });
});
