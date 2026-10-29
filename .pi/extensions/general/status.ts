import type { ThemeColor } from "@earendil-works/pi-coding-agent";

export const statusDefinitions = {
  idle: { role: "muted", priority: 0, glyph: "○" },
  done: { role: "success", priority: 1, glyph: "✓" },
  error: { role: "error", priority: 2, glyph: "✗" },
  // Static: animating at Pi's loader cadence would need a tmux write every 80 ms.
  running: { role: "accent", priority: 3, glyph: "⠾" },
} as const satisfies Record<string, { role: ThemeColor; priority: number; glyph: string }>;

export type StatusState = keyof typeof statusDefinitions;

export function isStatusState(value: string): value is StatusState {
  return Object.hasOwn(statusDefinitions, value);
}
