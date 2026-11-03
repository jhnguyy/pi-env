import type { KeybindingHints } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type Component } from "@earendil-works/pi-tui";

export const expansionHints: KeybindingHints = {
  keyText: () => "enabled",
  keyHint: () => "host hint",
};

// Content assertions use a wide viewport; layout assertions must choose their own width.
export function componentText(component: Component, width = 1000): string {
  return stripTerminalSequences(component.render(width).join("\n"));
}
