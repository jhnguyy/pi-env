/**
 * result.ts — shared tool result helpers.
 *
 * Used by agent-bus, orch, tmux, jit-catch (and any future extension).
 * Keeps the content/details shape consistent across all tool implementations.
 */

export function txt(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

export function ok(text: string) {
  return { content: [txt(text)], details: {} };
}

export function err(msg: string) {
  return { content: [txt(msg)], details: { error: msg } };
}
