import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { setSlot } from "../_shared/ui-render";
import { formatTodoMilestoneLabel } from "./milestones";
import { TodoStore } from "./store";

export const TodoAction = {
  Add: "add",
  Done: "done",
  Remove: "rm",
  List: "list",
  Clear: "clear",
} as const;
export type TodoAction = typeof TodoAction[keyof typeof TodoAction];

export type TodoParams = { action: TodoAction; text?: string[] };

type TodoResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

type TodoExecution = {
  store: TodoStore;
  params: TodoParams;
  ctx?: ExtensionContext;
  pi?: ExtensionAPI;
};

type TodoActionHandler = (execution: TodoExecution) => TodoResult;

const TODO_ACTION_DESCRIPTION = "add: create task, done: complete by id, rm: remove by id, list: show all, clear: reset";
const TODO_TEXT_DESCRIPTION = "Task text(s) for add; task id(s) for done/rm. ALWAYS pass as a JSON array — even for a single item. Examples: add [\"my task\"], done [\"1\"], rm [\"2\"]. Ignored for list and clear.";

export const TODO_PARAMETERS = Type.Object({
  action: Type.Union(
    [
      Type.Literal(TodoAction.Add),
      Type.Literal(TodoAction.Done),
      Type.Literal(TodoAction.Remove),
      Type.Literal(TodoAction.List),
      Type.Literal(TodoAction.Clear),
    ],
    { description: TODO_ACTION_DESCRIPTION },
  ),
  text: Type.Optional(Type.Array(Type.String(), { description: TODO_TEXT_DESCRIPTION })),
});

function parseTaskRef(ref: string): string | number {
  const n = parseInt(ref, 10);
  return Number.isNaN(n) ? ref : n;
}

function requireText(action: TodoAction, text: string[] | undefined): string[] {
  if (!text?.length) throw new Error(`text is required for ${action}`);
  return text;
}

function updateTodoSlot(store: TodoStore, ctx?: ExtensionContext): void {
  if (!ctx?.ui) return;
  setSlot("session-todos", store.renderWidget(ctx.ui.theme), ctx);
}

function textResult(text: string, details: Record<string, unknown> = {}): TodoResult {
  return { content: [{ type: "text", text }], details };
}

function formatCount(noun: string, count: number): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatIds(ids: number[]): string {
  return ids.join(", ");
}

function listTodos({ store }: TodoExecution): TodoResult {
  return textResult(store.render());
}

function clearTodos({ store, ctx }: TodoExecution): TodoResult {
  store.clear();
  updateTodoSlot(store, ctx);
  return textResult("Cleared all tasks.");
}

function addTodos({ store, params, ctx }: TodoExecution): TodoResult {
  const added = requireText(TodoAction.Add, params.text).map((text) => store.add(text));
  const ids = added.map((item) => item.id);
  updateTodoSlot(store, ctx);
  return textResult(
    `Added ${formatCount("task", added.length)}: id${ids.length === 1 ? "" : "s"} ${formatIds(ids)}.`,
    { ids },
  );
}

function completeTodos({ store, params, ctx, pi }: TodoExecution): TodoResult {
  const completedItems: Array<{ id: number; text: string }> = [];
  const failed: string[] = [];
  for (const ref of requireText(TodoAction.Done, params.text)) {
    const item = store.complete(parseTaskRef(ref));
    if (item) completedItems.push({ id: item.id, text: item.text });
    else failed.push(ref);
  }
  if (completedItems.length === 0) throw new Error(`No matching open tasks: ${failed.join(", ")}`);

  const leafId = ctx?.sessionManager?.getLeafId?.();
  const milestoneLabel = formatTodoMilestoneLabel(completedItems);
  if (pi && leafId && milestoneLabel) pi.setLabel(leafId, milestoneLabel);
  updateTodoSlot(store, ctx);

  const ids = completedItems.map((item) => item.id);
  const parts: string[] = [];
  if (completedItems.length) parts.push(`Completed ${formatCount("task", completedItems.length)}: id${ids.length === 1 ? "" : "s"} ${formatIds(ids)}.`);
  if (failed.length) parts.push(`Not found: ${failed.join(", ")}`);
  return textResult(parts.join("\n"), { ids, failed: failed.length });
}

function removeTodos({ store, params, ctx }: TodoExecution): TodoResult {
  const removedRefs: string[] = [];
  const failed: string[] = [];
  for (const ref of requireText(TodoAction.Remove, params.text)) {
    if (store.remove(parseTaskRef(ref))) removedRefs.push(ref);
    else failed.push(ref);
  }
  if (removedRefs.length === 0) throw new Error(`No matching tasks: ${failed.join(", ")}`);
  updateTodoSlot(store, ctx);

  const parts: string[] = [];
  if (removedRefs.length) parts.push(`Removed ${formatCount("task", removedRefs.length)}.`);
  if (failed.length) parts.push(`Not found: ${failed.join(", ")}`);
  return textResult(parts.join("\n"), { removed: removedRefs.length, failed: failed.length });
}

const TODO_ACTION_HANDLERS = {
  [TodoAction.Add]: addTodos,
  [TodoAction.Done]: completeTodos,
  [TodoAction.Remove]: removeTodos,
  [TodoAction.List]: listTodos,
  [TodoAction.Clear]: clearTodos,
} satisfies Record<TodoAction, TodoActionHandler>;

export function prepareTodoArguments(args: unknown): unknown {
  if (!args || typeof args !== "object") return args;
  const record = args as Record<string, unknown>;
  if (typeof record.text === "string") return { ...record, text: [record.text] };
  return args;
}

export function executeTodo(store: TodoStore, params: TodoParams, ctx?: ExtensionContext, pi?: ExtensionAPI): TodoResult {
  return TODO_ACTION_HANDLERS[params.action]({ store, params, ctx, pi });
}
