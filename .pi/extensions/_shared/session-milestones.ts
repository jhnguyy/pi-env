export const SessionMilestoneKind = {
  Todo: "todo",
} as const;
export type SessionMilestoneKind = typeof SessionMilestoneKind[keyof typeof SessionMilestoneKind];

export const TODO_MILESTONE_PREFIX = `${SessionMilestoneKind.Todo}:`;

export interface SessionMilestoneLabel {
  kind: SessionMilestoneKind;
  text: string;
}

export function formatTodoSessionMilestone(text: string): string {
  return `${TODO_MILESTONE_PREFIX} ${text.replace(/\s+/g, " ").trim().slice(0, 80)}`;
}

export function parseSessionMilestoneLabel(label: string): SessionMilestoneLabel | undefined {
  const match = label.match(/^todo:\s*(.+)$/);
  if (!match) return undefined;
  const text = match[1]?.trim();
  return text ? { kind: SessionMilestoneKind.Todo, text } : undefined;
}
