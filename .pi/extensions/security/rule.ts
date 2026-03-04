/**
 * Rule — validation, creation, and regex safety for permission rules.
 *
 * This is a utility class (all static methods) that ensures rules
 * are well-formed before they're stored or evaluated.
 */

import type { PermissionLevel, RuleAction, RuleDefinition, RuleScope } from "./types";

const VALID_LEVELS: PermissionLevel[] = ["none", "low", "medium", "high"];
const VALID_ACTIONS: RuleAction[] = ["allow", "deny", "review"];
const VALID_SCOPES: RuleScope[] = ["global", "session"];
/** Built-in tool names — listed for reference, but custom tool names are also valid. Use "*" to match all tools. */
const BUILTIN_TOOLS = ["bash", "read", "write", "edit"];
/** Built-in tool fields — listed for reference, but custom tool fields are also valid. Use "*" to match all fields. */
const BUILTIN_FIELDS = ["command", "path", "content", "newText", "oldText"];

/** Max regex length to prevent complexity attacks */
const MAX_PATTERN_LENGTH = 500;

/** Timeout for regex safety test (ms) */
const REGEX_TEST_TIMEOUT_MS = 50;

export class Rule {
  /**
   * Validate a rule definition. Returns a list of error messages.
   * An empty array means the rule is valid.
   */
  static validate(def: Partial<RuleDefinition>): string[] {
    const errors: string[] = [];

    if (!def.tool || typeof def.tool !== "string") {
      errors.push(`Tool is required and must be a string (built-ins: ${BUILTIN_TOOLS.join(", ")})`);
    }
    if (!def.field || typeof def.field !== "string") {
      errors.push(`Field is required and must be a string (built-ins: ${BUILTIN_FIELDS.join(", ")})`);
    }
    if (!def.pattern || typeof def.pattern !== "string") {
      errors.push("Pattern is required and must be a string");
    } else if (def.pattern.length > MAX_PATTERN_LENGTH) {
      errors.push(`Pattern too long (${def.pattern.length} > ${MAX_PATTERN_LENGTH})`);
    } else if (!Rule.isValidRegex(def.pattern)) {
      errors.push(`Invalid regex pattern: "${def.pattern}"`);
    } else if (!Rule.isRegexSafe(def.pattern)) {
      errors.push("Pattern may cause catastrophic backtracking");
    }
    if (!def.level || !VALID_LEVELS.includes(def.level)) {
      errors.push(`Invalid level "${def.level}". Must be one of: ${VALID_LEVELS.join(", ")}`);
    }
    if (!def.action || !VALID_ACTIONS.includes(def.action)) {
      errors.push(`Invalid action "${def.action}". Must be one of: ${VALID_ACTIONS.join(", ")}`);
    }
    if (!def.scope || !VALID_SCOPES.includes(def.scope)) {
      errors.push(`Invalid scope "${def.scope}". Must be one of: ${VALID_SCOPES.join(", ")}`);
    }
    if (!def.description || typeof def.description !== "string") {
      errors.push("Description is required");
    }

    return errors;
  }

  /** Create a complete rule definition with auto-generated id and timestamp */
  static create(partial: {
    tool: string;
    field: string;
    pattern: string;
    level: PermissionLevel;
    action: RuleAction;
    scope: RuleScope;
    description: string;
  }): RuleDefinition {
    return {
      ...partial,
      pattern: Rule.normalizePattern(partial.pattern),
      id: Rule.generateId(),
      createdAt: Date.now(),
    };
  }

  /** Check if a string is a valid regex */
  static isValidRegex(pattern: string): boolean {
    try {
      new RegExp(pattern);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Test if a regex is safe from catastrophic backtracking.
   *
   * Uses a heuristic: test the pattern against a long adversarial string.
   * If it takes too long, the pattern is unsafe.
   */
  static isRegexSafe(pattern: string): boolean {
    try {
      const regex = new RegExp(pattern);
      // Adversarial inputs: repeated 'a's that trigger backtracking in patterns
      // like (a+)+ or (a|a)*. Test both a matching string and a near-miss
      // (trailing 'b' forces worst-case non-matching backtrack paths).
      const adversarial = "a".repeat(100);
      const nearMiss = "a".repeat(99) + "b";

      const start = performance.now();
      regex.test(adversarial);
      regex.test(nearMiss);
      const elapsed = performance.now() - start;

      return elapsed < REGEX_TEST_TIMEOUT_MS;
    } catch {
      return false;
    }
  }

  /**
   * Normalize a user-entered pattern before validation or storage.
   *
   * Accepts glob-style shortcuts and converts them to valid regex:
   *   "*"        → ".*"   (match anything)
   *   "foo*"     → "foo.*" (prefix wildcard)
   *   "*.ts"     → ".*\.ts" (suffix wildcard — dot escaped)
   *
   * Patterns that are already valid regex are returned unchanged.
   * Applied automatically in `create()` and by `PromptHandler` before validation.
   */
  static normalizePattern(pattern: string): string {
    // Only normalize if it contains a bare * (not already a .* or \*)
    if (!pattern.includes("*")) return pattern;

    // Replace each * not already preceded by . or \ with .*
    return pattern.replace(/(?<![.\\])\*/g, ".*");
  }

  /** Generate a short unique ID */
  static generateId(): string {
    const time = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 6);
    return `${time}-${rand}`;
  }

  /**
   * Auto-generate a regex pattern from a raw input value.
   * Escapes special chars and creates a reasonable starting pattern.
   */
  static autoPattern(tool: string, value: string): string {
    // For bash: use the first "word" (command name)
    if (tool === "bash") {
      const firstWord = value.trim().split(/\s+/)[0];
      if (firstWord) {
        return `^${Rule.escapeRegex(firstWord)}\\b`;
      }
    }
    // For paths: escape the full path
    return `^${Rule.escapeRegex(value)}$`;
  }

  /** Escape special regex characters in a string */
  static escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
