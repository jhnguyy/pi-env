/**
 * PermissionEngine — orchestrates threat analysis, rule matching,
 * and level resolution into a single evaluation result.
 *
 * Pipeline: analyze threats → match rules → resolve level → decide
 *
 * Key invariants:
 *   - Threats can ONLY raise level, never lower it
 *   - Threats escalate "allow" → "review" but NEVER weaken "deny" → "review"
 *   - Deny action ALWAYS produces a deny decision, regardless of level
 *   - Pipes trigger per-segment evaluation; any denied segment blocks the whole command
 *   - Unknown patterns (no rule) default to "review" at "medium"
 *   - TRUSTED ALLOW: a rule with level:"none" + action:"allow" is an explicit trust
 *     declaration. Threats are audited but do NOT force a review prompt. Block rules
 *     act as the gates — anything passing them and matching a trusted allow is silent.
 */

import type { PatternMatcher } from "./pattern-matcher";
import type { RuleStore } from "./rule-store";
import type { ThreatAnalyzer } from "./threat-analyzer";
import type {
  EvaluationResult,
  PermissionLevel,
  PipeSegmentResult,
  RuleDefinition,
  ThreatMatch,
  ToolInput,
} from "./types";
import { LEVEL_WEIGHT, SESSION_MODE_DESCRIPTIONS, maxLevel, resolveFieldValue, summarizeInput as summarize } from "./types";

export class PermissionEngine {
  constructor(
    private analyzer: ThreatAnalyzer,
    private matcher: PatternMatcher,
    private ruleStore: RuleStore,
  ) {}

  /** Evaluate a tool call and return the permission decision */
  evaluate(tool: string, input: ToolInput): EvaluationResult {
    const threats = this.analyzer.analyze(tool, input);
    const rules = this.ruleStore.getAllRules();
    const rule = this.matcher.findMatch(tool, input, rules);

    let level: PermissionLevel = rule?.level ?? "medium";
    let action: "allow" | "deny" | "review" = rule?.action ?? "review";

    // Trusted allow: level:"none" + action:"allow" is an explicit unconditional pass.
    // The user has declared "I trust everything that reaches this rule."
    // Threats are still recorded in the audit log but do NOT trigger a prompt.
    const isTrustedAllow = rule !== null && rule.action === "allow" && rule.level === "none";

    // Threat escalation: raise level, escalate allow→review (unless explicitly trusted).
    // Never weaken deny→review — deny is MORE restrictive than review.
    if (threats.length > 0) {
      level = maxLevel(level, this.maxThreatLevel(threats));
      if (action === "allow" && !isTrustedAllow) action = "review";
    }

    // Pipe segment evaluation: split the command and evaluate each part
    const hasPipe = threats.some((t) => t.descriptor.id === "pipe");
    let pipeSegments: PipeSegmentResult[] | undefined;

    if (hasPipe && tool === "bash") {
      const command = resolveFieldValue(tool, input);
      const rawSegments = this.splitOnSinglePipe(command);

      // Only meaningful when the command actually splits into multiple parts
      if (rawSegments.length > 1) {
        pipeSegments = rawSegments.map((seg) => this.evaluateSegment(seg, rules));

        // Any denied segment → block the whole command immediately
        const deniedSeg = pipeSegments.find((s) => s.segmentDecision === "deny");
        if (deniedSeg) {
          return {
            decision: "deny",
            effectiveLevel: "high",
            matchedRule: rule,
            threats,
            reason: `Pipe blocked — segment "${deniedSeg.command}" matches a deny rule`,
            pipeSegments,
          };
        }

        // Raise level from per-segment threats (e.g. sudo inside a segment)
        for (const seg of pipeSegments) {
          for (const t of seg.threats) {
            level = maxLevel(level, t.descriptor.level);
          }
        }
      }
    }

    // Review action needs at least medium level to be meaningful
    if (action === "review" && LEVEL_WEIGHT[level] < LEVEL_WEIGHT["medium"]) {
      level = "medium";
    }

    // Final decision
    let decision: "allow" | "deny" | "review";
    if (action === "deny") {
      decision = "deny";                                         // Always deny
    } else if (isTrustedAllow) {
      decision = "allow";                                        // Explicit trust — skip level check
    } else if (action === "allow" && LEVEL_WEIGHT[level] <= LEVEL_WEIGHT["low"]) {
      decision = "allow";                                        // Silent allow at none/low
    } else {
      decision = "review";                                       // Prompt for everything else
    }

    const baseResult: EvaluationResult = {
      decision,
      effectiveLevel: level,
      matchedRule: rule,
      threats,
      reason: this.buildReason(rule, threats, decision, pipeSegments),
      pipeSegments,
    };

    return this.applySessionMode(tool, baseResult);
  }

  /**
   * Apply the current session mode as a post-evaluation override.
   *
   * permissive — silently allow any "review" decision
   * lockdown   — deny any bash/write/edit call (reads pass through)
   * default    — no change
   */
  private applySessionMode(tool: string, result: EvaluationResult): EvaluationResult {
    const mode = this.ruleStore.getSessionMode();
    if (mode === "default") return result;

    if (mode === "permissive" && result.decision === "review") {
      return {
        ...result,
        decision: "allow",
        reason: `[permissive mode] ${result.reason}`,
      };
    }

    if (mode === "lockdown" && tool !== "read") {
      return {
        ...result,
        decision: "deny",
        effectiveLevel: "high",
        reason: `[lockdown mode] ${SESSION_MODE_DESCRIPTIONS.lockdown}`,
      };
    }

    return result;
  }

  /** Summarize tool input for audit logging */
  summarizeInput(tool: string, input: ToolInput): string {
    return summarize(tool, input);
  }

  // ─── Private Helpers ──────────────────────────────────────────────

  /**
   * Split a command on single pipes only, not || (logical OR).
   * Returns the full command as a single-element array if no real pipe found.
   */
  private splitOnSinglePipe(command: string): string[] {
    return command
      .split(/(?<!\|)\|(?!\|)/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** Evaluate a single pipe segment against rules and threats */
  private evaluateSegment(segment: string, rules: RuleDefinition[]): PipeSegmentResult {
    const segInput: ToolInput = { command: segment };

    // Detect threats within this segment, but exclude the pipe threat itself
    // (we already know there's a pipe — it's not meaningful per-segment)
    const segThreats = this.analyzer
      .analyze("bash", segInput)
      .filter((t) => t.descriptor.id !== "pipe" && t.descriptor.id !== "chain-or");

    const matchedRule = this.matcher.findMatch("bash", segInput, rules);

    const segmentDecision: PipeSegmentResult["segmentDecision"] =
      !matchedRule ? "unknown"
      : matchedRule.action === "deny" ? "deny"
      : matchedRule.action === "review" ? "review"
      : "allow";

    return { command: segment, matchedRule, threats: segThreats, segmentDecision };
  }

  private maxThreatLevel(threats: ThreatMatch[]): PermissionLevel {
    return threats.reduce(
      (max, t) => maxLevel(max, t.descriptor.level),
      "none" as PermissionLevel,
    );
  }

  private buildReason(
    rule: EvaluationResult["matchedRule"],
    threats: ThreatMatch[],
    decision: string,
    pipeSegments?: PipeSegmentResult[],
  ): string {
    const parts: string[] = [];

    parts.push(rule
      ? `Rule "${rule.description}" (${rule.action}/${rule.level})`
      : "No matching rule (unknown pattern)");

    if (threats.length > 0) {
      parts.push(`Threats: ${threats.map((t) => t.descriptor.id).join(", ")}`);
    }

    if (pipeSegments) {
      const unknown = pipeSegments.filter((s) => s.segmentDecision === "unknown").length;
      if (unknown > 0) parts.push(`${unknown} unknown pipe segment(s)`);
    }

    parts.push(`Decision: ${decision}`);
    return parts.join(" | ");
  }
}
