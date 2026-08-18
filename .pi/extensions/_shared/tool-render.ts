import { keyHint, keyText, rawKeyHint } from "@earendil-works/pi-coding-agent";

export interface ToolRenderTheme {
  fg(color: string, text: string): string;
}

export function toolExpandKeyHint(description = "to expand"): string {
  return keyText("app.tools.expand")
    ? keyHint("app.tools.expand", description)
    : rawKeyHint("ctrl+o", description);
}

export function toolExpandHint(
  theme: ToolRenderTheme,
  description = "to expand",
): string {
  return `${theme.fg("muted", "(")}${toolExpandKeyHint(description)}${theme.fg("muted", ")")}`;
}
