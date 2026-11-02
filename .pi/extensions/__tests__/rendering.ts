import type { KeybindingHints } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type Component } from "@earendil-works/pi-tui";

export function expansionHints(binding: string): KeybindingHints {
  return {
    keyText: (id) => (id === "app.tools.expand" ? binding : ""),
    keyHint: (id, description) => {
      if (!binding) throw new Error("Disabled expansion binding must not be formatted");
      if (id !== "app.tools.expand") return "";
      return `${binding} ${description}`;
    },
  };
}

// Content assertions use a wide viewport; layout assertions must choose their own width.
export function componentText(component: Component, width = 1000): string {
  return stripTerminalSequences(component.render(width).join("\n"));
}
