import { describe, it, expect, beforeEach } from "bun:test";
import { TodoStore } from "../store";

describe("TodoStore", () => {
  let store: TodoStore;

  beforeEach(() => {
    store = new TodoStore();
  });

  // ─── add ──────────────────────────────────────────────────────────

  it("add() creates item with incrementing id, done=false", () => {
    const a = store.add("first task");
    const b = store.add("second task");
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(a.done).toBe(false);
    expect(b.done).toBe(false);
    expect(a.text).toBe("first task");
  });

  it("add() sets addedAt timestamp", () => {
    const item = store.add("task");
    expect(item.addedAt).toBeTruthy();
    expect(() => new Date(item.addedAt)).not.toThrow();
  });

  // ─── complete ─────────────────────────────────────────────────────

  it("complete(id) marks task done and sets completedAt", () => {
    store.add("task one");
    const result = store.complete(1);
    expect(result).not.toBeNull();
    expect(result!.done).toBe(true);
    expect(result!.completedAt).toBeTruthy();
  });

  it("complete(text) matches by partial text, case-insensitive", () => {
    store.add("Fix LSP socket paths");
    const result = store.complete("lsp socket");
    expect(result).not.toBeNull();
    expect(result!.done).toBe(true);
  });

  it("complete() returns null for nonexistent id", () => {
    store.add("task");
    const result = store.complete(99);
    expect(result).toBeNull();
  });

  it("complete() returns null for nonexistent text", () => {
    store.add("task");
    const result = store.complete("nope");
    expect(result).toBeNull();
  });

  it("complete() returns null for already-done task", () => {
    store.add("task");
    store.complete(1);
    const second = store.complete(1);
    expect(second).toBeNull();
  });

  // ─── remove ──────────────────────────────────────────────────────

  it("remove(id) removes item and returns true", () => {
    store.add("task one");
    const ok = store.remove(1);
    expect(ok).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  it("remove(text) removes by partial text match", () => {
    store.add("update vault note");
    const ok = store.remove("vault");
    expect(ok).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  it("remove() returns false for nonexistent ref", () => {
    const ok = store.remove(42);
    expect(ok).toBe(false);
  });

  it("ids are stable after remove (no renumbering)", () => {
    store.add("first");
    store.add("second");
    store.add("third");
    store.remove(2);
    const ids = store.list().map((i) => i.id);
    expect(ids).toEqual([1, 3]);
  });

  // ─── clear ───────────────────────────────────────────────────────

  it("clear() empties the list", () => {
    store.add("a");
    store.add("b");
    store.clear();
    expect(store.list()).toHaveLength(0);
  });

  it("clear() resets id counter", () => {
    store.add("a");
    store.clear();
    const item = store.add("new task");
    expect(item.id).toBe(1);
  });

  // ─── list / open ─────────────────────────────────────────────────

  it("list() returns all items in insertion order", () => {
    store.add("first");
    store.add("second");
    store.add("third");
    const ids = store.list().map((i) => i.id);
    expect(ids).toEqual([1, 2, 3]);
  });

  it("open() returns only undone items", () => {
    store.add("done task");
    store.add("open task");
    store.complete(1);
    const open = store.open();
    expect(open).toHaveLength(1);
    expect(open[0].text).toBe("open task");
  });

  // ─── render ──────────────────────────────────────────────────────

  it('render() returns "No tasks yet." when empty', () => {
    expect(store.render()).toBe("[session-todos] No tasks yet.");
  });

  it("render() formats a single open task correctly", () => {
    store.add("slim work-tracker extension");
    expect(store.render()).toBe("[session-todos]\n□ (1) slim work-tracker extension");
  });

  it("render() shows □ for open, ✅ for done", () => {
    store.add("open task");
    store.add("done task");
    store.complete(2);
    const output = store.render();
    expect(output).toContain("□ (1) open task");
    expect(output).toContain("✅ (2) done task");
    expect(output.startsWith("[session-todos]")).toBe(true);
  });

  it("render() shows stable ids after remove", () => {
    store.add("first");
    store.add("second");
    store.add("third");
    store.remove(2);
    const output = store.render();
    expect(output).toContain("□ (1) first");
    expect(output).toContain("□ (3) third");
    expect(output).not.toContain("second");
  });
});
