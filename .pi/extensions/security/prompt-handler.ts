/**
 * PromptHandler — UI prompts for unknown or review-required tool calls.
 *
 * Navigation model:
 *   The flow is a small step machine. Completing a step pushes it onto a
 *   history stack and advances to the next step. Every sub-step dialog
 *   includes "← Back" as the last option; selecting it pops the history
 *   stack and returns to the previous step — resetting that step's value
 *   so the user re-enters it cleanly.
 *
 * Step graph:
 *
 *   main ──► segment ──┐
 *        └──► pattern ─┤
 *        └────────────►action ──► level ──► scope ──► done
 *
 *   Back at any step returns to the previous step in history.
 *   Back at the first real step returns to main (user can re-choose).
 *   Cancelling at main → blocked. Allowing once → allow-once (no rule).
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Rule } from "./rule";
import type { RuleStore } from "./rule-store";
import type {
  EvaluationResult,
  PermissionLevel,
  RuleAction,
  ToolInput,
  UserPromptResult,
} from "./types";
import { getPrimaryField, resolveFieldValue } from "./types";

// ─── Option Lists ──────────────────────────────────────────────────

const BACK = "← Back" as const;

const ACTION_OPTIONS = ["Allow once", "Add rule", "Modify pattern", "Cancel"] as const;

const RULE_ACTION_OPTIONS = [
  { label: "Allow — let the call proceed",    value: "allow"  as RuleAction },
  { label: "Deny — block the call",           value: "deny"   as RuleAction },
  { label: "Review — prompt every time",      value: "review" as RuleAction },
] as const;

const LEVEL_OPTIONS = [
  { label: "None   — silent, no logging",              value: "none"   as PermissionLevel },
  { label: "Low    — log only, no prompt",             value: "low"    as PermissionLevel },
  { label: "Medium — prompt for confirmation",         value: "medium" as PermissionLevel },
  { label: "High   — prompt with full threat detail",  value: "high"   as PermissionLevel },
] as const;

const SCOPE_OPTIONS = ["Global (all sessions)", "Session only"] as const;

// ─── Step Types ────────────────────────────────────────────────────

type Step = "main" | "segment" | "pattern" | "action" | "level" | "scope";

// ─── PromptHandler ─────────────────────────────────────────────────

export class PromptHandler {
  constructor(private ruleStore: RuleStore) {}

  /** Run the interactive permission prompt. Returns a decision and optional rule to persist. */
  async prompt(
    tool: string,
    input: ToolInput,
    result: EvaluationResult,
    ctx: ExtensionContext,
  ): Promise<UserPromptResult> {
    const title = this.buildTitle(tool, input, result);

    // Pre-compute unknown pipe segments (used in the segment step)
    const unknownSegments = (result.pipeSegments ?? [])
      .filter((s) => s.segmentDecision === "unknown")
      .map((s) => s.command);

    // ── Step machine state ──────────────────────────────────────────
    const history: Step[] = [];
    let current: Step = "main";

    // Values accumulated across steps. Reset when revisiting a step.
    let mainChoice: "Add rule" | "Modify pattern" | null = null;
    let targetValue = resolveFieldValue(tool, input);
    let pattern: string | null = null;
    let ruleAction: RuleAction | null = null;
    let level: PermissionLevel | null = null;

    // ── Main loop ───────────────────────────────────────────────────
    while (true) {
      switch (current) {

        // ── Step: main ────────────────────────────────────────────
        case "main": {
          // Reset all derived state when (re)visiting main
          mainChoice = null;
          pattern = null;
          ruleAction = null;
          level = null;
          targetValue = resolveFieldValue(tool, input);

          const choice = await ctx.ui.select(title, [...ACTION_OPTIONS]);

          if (!choice || choice === "Cancel") return { decision: "blocked" };
          if (choice === "Allow once")         return { decision: "allow-once" };

          mainChoice = choice as "Add rule" | "Modify pattern";
          history.push("main");

          if (mainChoice === "Add rule" && unknownSegments.length > 0) {
            current = "segment";
          } else if (mainChoice === "Modify pattern") {
            current = "pattern";
          } else {
            current = "action";
          }
          break;
        }

        // ── Step: segment (pipe context only) ────────────────────
        case "segment": {
          // Reset targetValue so the user makes a fresh pick
          targetValue = resolveFieldValue(tool, input);

          const choice = await ctx.ui.select(
            "Add rule for which part?",
            [...unknownSegments, "Whole command", BACK],
          );

          if (!choice)     return { decision: "allow-once" };
          if (choice === BACK) { current = history.pop() ?? "main"; break; }

          if (choice !== "Whole command") targetValue = choice;
          history.push("segment");
          current = "action";
          break;
        }

        // ── Step: pattern (Modify pattern only) ──────────────────
        case "pattern": {
          // Show previous entry as default so the user can refine it
          const defaultPattern = Rule.autoPattern(tool, targetValue);
          const edited = await ctx.ui.input(
            `Edit pattern for [${tool}]:`,
            pattern ?? defaultPattern,
          );

          // undefined = user cancelled the input field → treat as back
          if (edited === undefined) { current = history.pop() ?? "main"; break; }

          const normalized = Rule.normalizePattern(edited);
          if (!Rule.isValidRegex(normalized)) {
            ctx.ui.notify(`Invalid regex: "${normalized}". Try again.`, "warning");
            break; // Stay on this step
          }

          pattern = normalized;
          history.push("pattern");
          current = "action";
          break;
        }

        // ── Step: action ─────────────────────────────────────────
        case "action": {
          ruleAction = null;

          const choice = await ctx.ui.select(
            "Rule action:",
            [...RULE_ACTION_OPTIONS.map((o) => o.label), BACK],
          );

          if (!choice)     return { decision: "allow-once" };
          if (choice === BACK) { current = history.pop() ?? "main"; break; }

          ruleAction = RULE_ACTION_OPTIONS.find((o) => o.label === choice)!.value;
          history.push("action");
          current = "level";
          break;
        }

        // ── Step: level ───────────────────────────────────────────
        case "level": {
          level = null;

          const choice = await ctx.ui.select(
            "Permission level:",
            [...LEVEL_OPTIONS.map((o) => o.label), BACK],
          );

          if (!choice)     return { decision: "allow-once" };
          if (choice === BACK) { current = history.pop() ?? "main"; break; }

          level = LEVEL_OPTIONS.find((o) => o.label === choice)!.value;
          history.push("level");
          current = "scope";
          break;
        }

        // ── Step: scope (final) ───────────────────────────────────
        case "scope": {
          const choice = await ctx.ui.select(
            "Rule scope:",
            [...SCOPE_OPTIONS, BACK],
          );

          if (!choice)     return { decision: "allow-once" };
          if (choice === BACK) { current = history.pop() ?? "main"; break; }

          const scope = choice === "Global (all sessions)" ? "global" : "session";

          // Use user-edited pattern for "Modify pattern", auto-generate otherwise
          const finalPattern = mainChoice === "Modify pattern"
            ? pattern!
            : Rule.autoPattern(tool, targetValue);

          const rule = Rule.create({
            tool,
            field: getPrimaryField(tool) ?? "*",
            pattern: finalPattern,
            level: level!,
            action: ruleAction!,
            scope: scope as "global" | "session",
            description: this.autoDescription(tool, finalPattern),
          });

          return { decision: "allow", rule };
        }
      }
    }
  }

  // ─── Private Helpers ──────────────────────────────────────────────

  /** Build the dialog title: input preview + pipe segments + threats */
  private buildTitle(tool: string, input: ToolInput, result: EvaluationResult): string {
    const lines: string[] = [];
    const icon = result.effectiveLevel === "high" ? "🔴" : "🟡";
    lines.push(`${icon} Permission review — ${tool}`);

    // Full input — no truncation
    const fieldValue = resolveFieldValue(tool, input);
    if (fieldValue) lines.push(`  ${fieldValue}`);

    // Pipe segment breakdown
    if (result.pipeSegments && result.pipeSegments.length > 0) {
      lines.push("");
      lines.push("Pipe segments:");
      for (const seg of result.pipeSegments) {
        const statusIcon =
          seg.segmentDecision === "allow"  ? "✓" :
          seg.segmentDecision === "deny"   ? "✗" :
          seg.segmentDecision === "review" ? "⚠" : "?";
        const label    = seg.segmentDecision.padEnd(7);
        const ruleInfo = seg.matchedRule ? `[${seg.matchedRule.description}]` : "[no rule]";
        const threats  = seg.threats.length > 0
          ? `  ⚡ ${seg.threats.map((t) => t.descriptor.id).join(", ")}`
          : "";
        lines.push(`  ${statusIcon} ${label}  ${seg.command}  ${ruleInfo}${threats}`);
      }
    }

    // Overall threats
    if (result.threats.length > 0) {
      lines.push("");
      lines.push("Threats detected:");
      for (const t of result.threats) {
        const tIcon = t.descriptor.level === "high" ? "⚡" : "⚠️";
        lines.push(`  ${tIcon} [${t.descriptor.level.toUpperCase()}] ${t.descriptor.description}`);
      }
    }

    if (result.matchedRule) {
      lines.push("");
      lines.push(`Matched rule: "${result.matchedRule.description}" (escalated by threats)`);
    }

    return lines.join("\n");
  }

  private autoDescription(tool: string, pattern: string): string {
    const cleaned = pattern
      .replace(/^\^/, "").replace(/\$$/, "")
      .replace(/\\b/g, "").replace(/\\/g, "");
    return `${tool}: ${cleaned}`;
  }
}
