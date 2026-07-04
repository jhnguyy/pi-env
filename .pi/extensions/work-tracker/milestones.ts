import { formatTodoSessionMilestone } from "../_shared/session-milestones";

export interface CompletedTodoMilestone {
  id: number;
  text: string;
}

export function formatTodoMilestoneLabel(items: CompletedTodoMilestone[]): string | undefined {
  if (items.length === 0) return undefined;
  const [first] = items;
  const suffix = items.length === 1 ? first.text : `${first.text} +${items.length - 1}`;
  return formatTodoSessionMilestone(suffix);
}
