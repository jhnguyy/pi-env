/**
 * Shared types for the skill-builder extension.
 */

/** Result of a single validation check. */
export interface ValidationIssue {
  rule: string;
  severity: "error" | "warning" | "info";
  message: string;
  /** File path relative to skill root, if applicable. */
  file?: string;
}

/** Aggregate validation result. */
export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  /** Skill name extracted from frontmatter, if parseable. */
  name?: string;
}

/** Parsed SKILL.md frontmatter. */
export interface SkillFrontmatter {
  name?: string;
  description?: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
  "allowed-tools"?: string;
  "disable-model-invocation"?: boolean;
  [key: string]: unknown;
}

/** Template types available for scaffolding. */
export type TemplateType = "basic" | "with-scripts" | "with-index";

/** Options for scaffolding a new skill. */
export interface ScaffoldOptions {
  name: string;
  description: string;
  template: TemplateType;
  /** Target parent directory. Defaults to ~/.pi/agent/skills/ */
  targetDir?: string;
}

/** Result of scaffolding. */
export interface ScaffoldResult {
  success: boolean;
  skillDir: string;
  filesCreated: string[];
  error?: string;
}

/** Token economy metadata for evaluation tracking. */
export interface TokenEconomy {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estimatedCost: number;
  /** "api" | "self-hosted" — self-hosted cost is compute, not per-token */
  costModel: "api" | "self-hosted";
}

/** LLM evaluation result (phase 1b). */
export interface EvaluationResult {
  skillName: string;
  evaluatedAt: string;
  verdict: "pass" | "fail" | "needs-revision";
  findings: EvaluationFinding[];
  tokenEconomy: TokenEconomy;
}

export interface EvaluationFinding {
  category: "clarity" | "completeness" | "context-efficiency" | "correctness" | "jit-catch";
  severity: "error" | "warning" | "info";
  message: string;
}
