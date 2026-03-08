import type { TodoItem } from "./types.ts";

export class TodoStore {
  private items: TodoItem[] = [];
  private nextId = 1;

  add(text: string): TodoItem {
    const item: TodoItem = {
      id: this.nextId++,
      text,
      done: false,
      addedAt: new Date().toISOString(),
    };
    this.items.push(item);
    return item;
  }

  /**
   * Mark a task complete by id (number) or partial text match (string).
   * Case-insensitive, first match wins. Returns the item or null if not found.
   */
  complete(ref: number | string): TodoItem | null {
    const item = this._find(ref);
    if (!item || item.done) return null;
    item.done = true;
    item.completedAt = new Date().toISOString();
    return item;
  }

  /**
   * Remove a task by id (number) or partial text match (string).
   * Returns true if removed, false if not found.
   */
  remove(ref: number | string): boolean {
    const item = this._find(ref);
    if (!item) return false;
    this.items = this.items.filter((i) => i.id !== item.id);
    return true;
  }

  clear(): void {
    this.items = [];
    this.nextId = 1;
  }

  /** All items in insertion order. */
  list(): TodoItem[] {
    return [...this.items];
  }

  /** Only open (not done) items. */
  open(): TodoItem[] {
    return this.items.filter((i) => !i.done);
  }

  /** Formatted string for context injection. */
  render(): string {
    if (this.items.length === 0) return "[session-todos] No tasks yet.";
    const lines = this.items.map((i) => {
      const icon = i.done ? "✅" : "□";
      return `${icon} (${i.id}) ${i.text}`;
    });
    return `[session-todos]\n${lines.join("\n")}`;
  }

  private _find(ref: number | string): TodoItem | null {
    if (typeof ref === "number") {
      return this.items.find((i) => i.id === ref) ?? null;
    }
    const lower = ref.toLowerCase();
    return this.items.find((i) => i.text.toLowerCase().includes(lower)) ?? null;
  }
}
