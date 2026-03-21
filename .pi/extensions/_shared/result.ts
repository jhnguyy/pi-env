/**
 * @module _shared/result
 * @purpose Tool execute return values. Use for every success/error return in a tool.
 *
 * @example
 *   return ok("3 files changed");            // success — green ✓ in TUI
 *   return err("file not found");             // error — red in TUI
 *   return { content: [txt(body)], details }; // custom details for renderResult
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
