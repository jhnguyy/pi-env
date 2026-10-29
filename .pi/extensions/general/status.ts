import type { ThemeColor } from "@earendil-works/pi-coding-agent";

export const statusDefinitions = {
  idle: { role: "muted", priority: 0, frames: ["○"] },
  done: { role: "success", priority: 1, frames: ["✓"] },
  error: { role: "error", priority: 2, frames: ["✗"] },
  running: {
    role: "accent",
    priority: 3,
    // A two-frame pulse reads as deliberate at the best-effort polling cadence,
    // where a full braille spinner would look stalled.
    frames: ["⠶", "⠿"],
  },
} as const satisfies Record<
  string,
  {
    role: ThemeColor;
    priority: number;
    frames: readonly [string, ...string[]];
  }
>;

export type StatusState = keyof typeof statusDefinitions;

export function isStatusState(value: string): value is StatusState {
  return Object.hasOwn(statusDefinitions, value);
}
