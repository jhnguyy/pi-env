/**
 * dev-tools preference hints — nudge the agent toward dev-tools when it uses read/grep
 * on supported files.
 *
 * Pure functions — no side effects, no imports from pi SDK.
 */

import { isLspSupported } from "./filetypes";

// ─── State ────────────────────────────────────────────────────────────────────

export interface HintState {
  hintCount: number;
  hintedFiles: Set<string>;
  lastHintIndex: number;
  currentIndex: number;
}

export function createHintState(): HintState {
  return { hintCount: 0, hintedFiles: new Set(), lastHintIndex: 0, currentIndex: 0 };
}

export function resetHintState(state: HintState): void {
  state.hintCount = 0;
  state.hintedFiles.clear();
  state.lastHintIndex = 0;
  state.currentIndex = 0;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_HINTS = 5;
export const COOLDOWN = 3;

// ─── Detection ────────────────────────────────────────────────────────────────

/**
 * Detect if the given tool call warrants a dev-tools hint.
 * Returns a hint string or null. Mutates state when a hint is emitted.
 */
export function detectDevToolsHint(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
  state: HintState,
): string | null {
  state.currentIndex++;

  // Budget check
  if (state.hintCount >= MAX_HINTS) return null;

  // Cooldown check (only after at least one hint has been shown)
  if (state.hintCount > 0 && state.currentIndex - state.lastHintIndex < COOLDOWN) return null;

  let hint: string | null = null;

  if (toolName === "read") {
    // Pattern 1: read on lsp-supported file, full-file (no offset/limit)
    const path = typeof input?.path === "string" ? input.path : undefined;
    if (path && isLspSupported(path)) {
      if (input?.offset != null || input?.limit != null) return null;
      if (state.hintedFiles.has(path)) return null;
      state.hintedFiles.add(path);
      hint = `[dev-tools] To map this file's structure, try: dev-tools symbols { path: "${path}" }`;
    }
  } else if (toolName === "bash") {
    const command = typeof input?.command === "string" ? input.command : undefined;
    if (command) {
      // Pattern 3: cat on lsp-supported file (check before grep to avoid over-triggering)
      const catMatch = command.match(/\bcat\s+(\S+)/);
      if (catMatch && isLspSupported(catMatch[1]!)) {
        hint = `[dev-tools] To map this file's structure, try: dev-tools symbols { path: "${catMatch[1]}" }`;
      } else if (/\bgrep\b|\brg\b/.test(command)) {
        // Pattern 2: grep/rg (symbol lookups in code)
        // Detect if grepping for a specific function/class name (PascalCase or camelCase)
        // Requires at least one lowercase char to exclude ALL_CAPS constants (TODO, FIXME, etc.)
        const symbolMatch = command.match(/(?:grep|rg)\s+(?:-[^\s]+\s+)*["']?([A-Z][a-zA-Z0-9]*[a-z][a-zA-Z0-9]*|[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)["']?/);
        if (symbolMatch) {
          hint = `[dev-tools] For "${symbolMatch[1]}", try: dev-tools references (all usages), dev-tools incoming-calls (what calls it), or dev-tools symbols { query: "${symbolMatch[1]}" } (find definition)`;
        } else {
          hint = `[dev-tools] For symbol lookups in code, try: dev-tools references (call sites), dev-tools incoming-calls/outgoing-calls (call hierarchy), or dev-tools symbols { query: "..." } (workspace search)`;
        }
      }
    }
  }

  if (hint) {
    state.hintCount++;
    state.lastHintIndex = state.currentIndex;
    return hint;
  }

  return null;
}
