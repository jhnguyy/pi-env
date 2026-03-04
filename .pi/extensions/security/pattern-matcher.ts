/**
 * PatternMatcher — matches tool call inputs against permission rules.
 *
 * Rules are tested in order (session before global). First match wins.
 * Invalid regex patterns are skipped with a warning.
 */

import type { RuleDefinition, ToolInput } from "./types";
import { ACTION_PRIORITY, SCOPE_PRIORITY, resolveFieldValue } from "./types";

export class PatternMatcher {
  /** Compiled regex cache: pattern string → RegExp */
  private regexCache = new Map<string, RegExp | null>();

  /**
   * Find the first rule that matches the given tool call.
   * Returns null if no rule matches (unknown pattern).
   *
   * Rules are sorted by action priority before evaluation:
   *   deny (0) → review (1) → allow (2)
   *
   * This prevents a broad allow rule from masking a more specific deny,
   * regardless of insertion order in permissions.json. Relative order is
   * preserved within each priority tier, so session rules still take
   * priority over global rules of the same action.
   */
  findMatch(tool: string, input: ToolInput, rules: RuleDefinition[]): RuleDefinition | null {
    const sorted = [...rules].sort((a, b) => {
      const actionDiff = (ACTION_PRIORITY[a.action] ?? 2) - (ACTION_PRIORITY[b.action] ?? 2);
      if (actionDiff !== 0) return actionDiff;
      return (SCOPE_PRIORITY[a.scope] ?? 1) - (SCOPE_PRIORITY[b.scope] ?? 1);
    });
    for (const rule of sorted) {
      if (this.ruleMatches(rule, tool, input)) {
        return rule;
      }
    }
    return null;
  }

  /** Test whether a single rule matches the given tool call */
  private ruleMatches(rule: RuleDefinition, tool: string, input: ToolInput): boolean {
    // Tool must match (or rule is wildcard)
    if (rule.tool !== "*" && rule.tool !== tool) return false;

    // Get the field value to test against
    const fieldToCheck = rule.field === "*" ? undefined : rule.field;
    const value = resolveFieldValue(tool, input, fieldToCheck);
    if (!value) return false;

    // Compile and test the regex
    const regex = this.getRegex(rule.pattern);
    if (!regex) return false;

    return regex.test(value);
  }

  /** Get a compiled regex, using cache. Returns null for invalid patterns. */
  private getRegex(pattern: string): RegExp | null {
    if (this.regexCache.has(pattern)) {
      return this.regexCache.get(pattern)!;
    }

    try {
      const regex = new RegExp(pattern);
      this.regexCache.set(pattern, regex);
      return regex;
    } catch {
      console.warn(`[permissions] Invalid regex pattern: "${pattern}"`);
      this.regexCache.set(pattern, null);
      return null;
    }
  }

  /** Clear the regex cache (useful after rule changes) */
  clearCache(): void {
    this.regexCache.clear();
  }
}
