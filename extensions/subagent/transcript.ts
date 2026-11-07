import { stripTerminalSequences } from "@earendil-works/pi-tui";

export const DISPLAY_CHARACTERS = 32 * 1024;

export function plainChildText(text: string): string {
  return stripTerminalSequences(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block: unknown) => {
    if (!record(block)) return [];
    if (block.type === "text" && typeof block.text === "string") return [block.text];
    if (block.type === "toolCall" && typeof block.name === "string") return [`Tool: ${block.name}`];
    return [];
  }).join("\n");
}

/** Display the owner's native context; do not parse or rewrite its transcript file. */
export function childMessagesText(messages: readonly unknown[]): string {
  const text = messages.flatMap((message) => {
    if (!record(message)) return [];
    const diagnostic = typeof message.errorMessage === "string" ? message.errorMessage : "";
    const content = [contentText(message.content), diagnostic].filter(Boolean).join("\n");
    if (!content) return [];
    const label = message.role === "toolResult" ? `Tool result: ${String(message.toolName ?? "unknown")}` : String(message.role);
    return [`${label}\n${content}`];
  }).join("\n\n");
  const safe = plainChildText(text);
  return (safe.length > DISPLAY_CHARACTERS ? "[Earlier display content omitted; the native session file retains history.]\n\n" : "") +
    (safe.slice(-DISPLAY_CHARACTERS) || "No finalized child messages yet.");
}
