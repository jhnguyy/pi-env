/**
 * Shared types, enums, and constants for the permission system.
 * This is the "dictionary" for the entire extension — start here.
 */

// ─── Permission Levels ──────────────────────────────────────────────

/** From least to most restrictive */
export type PermissionLevel = "none" | "low" | "medium" | "high";

/** Numeric weights for level comparison */
export const LEVEL_WEIGHT: Record<PermissionLevel, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

/** Return the higher of two permission levels */
export function maxLevel(a: PermissionLevel, b: PermissionLevel): PermissionLevel {
  return LEVEL_WEIGHT[a] >= LEVEL_WEIGHT[b] ? a : b;
}

// ─── Rule Types ─────────────────────────────────────────────────────

export type RuleScope = "global" | "session";
export type RuleAction = "allow" | "deny" | "review";

/** Evaluation priority for rule actions — lower number wins (evaluated first). */
export const ACTION_PRIORITY: Record<RuleAction, number> = {
  deny:   0,
  review: 1,
  allow:  2,
};

/** Evaluation priority for rule scope — lower number wins (evaluated first). */
export const SCOPE_PRIORITY: Record<RuleScope, number> = {
  session: 0,
  global:  1,
};

/** A rule as stored in permissions.json or session entries */
export interface RuleDefinition {
  id: string;
  tool: string;        // "bash" | "read" | "write" | "edit" | "*"
  field: string;       // "command" | "path" | "content" | "newText"
  pattern: string;     // regex string
  level: PermissionLevel;
  action: RuleAction;
  scope: RuleScope;
  description: string;
  createdAt: number;
}

// ─── Threat Types ───────────────────────────────────────────────────

export type ThreatCategory =
  | "shell-operator"
  | "redirection"
  | "meta-execution"
  | "encoding"
  | "network"
  | "env-exposure"
  | "privilege-escalation"
  | "dangerous-path"
  | "sensitive-file"
  | "credential"
  | "path-traversal";

/** A pattern definition for auto-detected threats (pure data) */
export interface ThreatDescriptor {
  id: string;
  category: ThreatCategory;
  tools: string[];       // which tools, ["*"] for all
  field: string;         // which input field to test
  pattern: RegExp;
  level: PermissionLevel;
  description: string;
}

/** A threat that was detected in a specific tool call */
export interface ThreatMatch {
  descriptor: ThreatDescriptor;
  matchedText: string;
}

// ─── Pipe Segment Types ─────────────────────────────────────────────

/** Decision for a single pipe segment */
export type PipeSegmentDecision = "allow" | "deny" | "review" | "unknown";

/**
 * Evaluation of one command in a pipe chain.
 * e.g. "cat file | grep foo | wc -l" → 3 segments
 */
export interface PipeSegmentResult {
  /** The segment text (trimmed, without the | character) */
  command: string;
  /** Matching rule for this segment, or null if unknown */
  matchedRule: RuleDefinition | null;
  /** Threats detected within this segment alone (pipe threat excluded) */
  threats: ThreatMatch[];
  /** Decision for this segment in isolation */
  segmentDecision: PipeSegmentDecision;
}

// ─── Engine Types ───────────────────────────────────────────────────

/** Result of evaluating a tool call */
export interface EvaluationResult {
  decision: "allow" | "deny" | "review";
  effectiveLevel: PermissionLevel;
  matchedRule: RuleDefinition | null;
  threats: ThreatMatch[];
  reason: string;
  /** Populated when a bash command contains a real pipe (not ||) */
  pipeSegments?: PipeSegmentResult[];
}

/** Result of prompting the user */
export interface UserPromptResult {
  decision: "allow" | "allow-once" | "deny" | "blocked";
  rule?: RuleDefinition;
}

// ─── Audit Types ────────────────────────────────────────────────────

export interface AuditEntry {
  timestamp: number;
  tool: string;
  inputSummary: string;
  matchedRuleId: string | null;
  threatIds: string[];
  decision: "allow" | "deny" | "allow-once" | "blocked";
  decidedBy: "rule" | "threat-escalation" | "user" | "auto";
  effectiveLevel: PermissionLevel;
}

// ─── Session Mode ────────────────────────────────────────────────────

/**
 * Session-scoped permission mode — overrides the normal rule evaluation
 * for the duration of the current session only.
 *
 * default    — rules as written; standard behavior
 * permissive — all "review" decisions become "allow" silently
 *              (useful for read-heavy sessions with many pipe commands)
 * lockdown   — deny all bash/write/edit calls; reads pass normally
 */
export type SessionMode = "default" | "permissive" | "lockdown";

export const SESSION_MODES: SessionMode[] = ["default", "permissive", "lockdown"];

export const SESSION_MODE_DESCRIPTIONS: Record<SessionMode, string> = {
  default:    "Standard — rules evaluated as written",
  permissive: "Permissive — review prompts skipped, all reviews become allow",
  lockdown:   "Lockdown — bash/write/edit denied; reads pass normally",
};

// ─── Config Types ───────────────────────────────────────────────────

/** Schema of ~/.pi/permissions.json */
export interface PermissionsConfig {
  version: number;
  /** Default session mode for new sessions. Omit or set to "default" for normal behaviour. */
  defaultMode?: SessionMode;
  rules: RuleDefinition[];
}

// ─── Utilities ──────────────────────────────────────────────────────

export type ToolInput = Record<string, unknown>;

/** Primary input field for each built-in tool */
const TOOL_PRIMARY_FIELD: Record<string, string> = {
  bash: "command",
  read: "path",
  write: "path",
  edit: "path",
};

/** Get the primary field name for a tool.
 *  For unknown (custom) tools, returns null — callers should handle this gracefully. */
export function getPrimaryField(tool: string): string | null {
  return TOOL_PRIMARY_FIELD[tool] ?? null;
}

/** Extract a field value from tool input, falling back to primary field.
 *  For custom tools with no known primary field, falls back to the first string-valued field. */
export function resolveFieldValue(tool: string, input: ToolInput, field?: string): string {
  if (field) {
    const value = input[field];
    return typeof value === "string" ? value : "";
  }

  const primary = getPrimaryField(tool);
  if (primary) {
    const value = input[primary];
    return typeof value === "string" ? value : "";
  }

  // Custom tool: use the first string-valued field in the input
  for (const value of Object.values(input)) {
    if (typeof value === "string") return value;
  }
  return "";
}

/** Summarize tool input for audit logging (truncated, no secrets) */
export function summarizeInput(tool: string, input: ToolInput): string {
  const primary = resolveFieldValue(tool, input);
  if (primary.length > 100) return primary.slice(0, 97) + "...";
  return primary || `(${Object.keys(input).join(", ")})`;
}
