/**
 * LLM-as-judge evaluator for skills.
 *
 * Design:
 * - Provider-agnostic: accepts model config, doesn't hardcode Anthropic
 * - Token-economy-aware: tracks cost per evaluation, distinguishes API vs self-hosted
 * - JiT-style: supports diff-aware evaluation (focus on what changed)
 * - Produces structured results suitable for notes tracking
 *
 * This module handles prompt construction and response parsing.
 * Actual LLM invocation is done by the caller (extension index.ts)
 * so this module stays testable without network dependencies.
 */

import type { EvaluationFinding, EvaluationResult, TokenEconomy } from "./types";

export interface EvalModelConfig {
  provider: string;
  model: string;
  costModel: "api" | "self-hosted";
  costPerInputToken: number;
  costPerOutputToken: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Shape we expect from the LLM evaluator response (validated before use). */
interface RawEvalResponse {
  verdict: unknown;
  findings: unknown;
}

const VALID_VERDICTS = new Set(["pass", "fail", "needs-revision"]);
const VALID_CATEGORIES = new Set([
  "clarity",
  "completeness",
  "context-efficiency",
  "correctness",
  "jit-catch",
]);
const VALID_SEVERITIES = new Set(["error", "warning", "info"]);

const RUBRIC = `## Evaluation Rubric

Judge only the capability promised by the description. Brevity and delegation are paramount; do not infer a tutorial, setup guide, or reference manual.

### clarity
Can an agent act without inventing requirements? Keep only non-obvious decisions, constraints, and retrieval steps.

### completeness
Is the stated capability minimally sufficient? Missing detail matters only when the skill owns it and cannot delegate it.

### context-efficiency
Does every instruction earn its recurring cost? Prefer authoritative sources over copied facts, and direct instructions over unnecessary indexes or references.

### correctness
Are stable claims accurate and changing facts retrieved at task time? Do references resolve where used?

### jit-catch (only when diff provided)
Do changes preserve scope, consistency, and context efficiency without leaving broken references?`;

/**
 * Build the evaluation prompt for the LLM judge.
 *
 * @param skillContent - Full content of SKILL.md
 * @param skillName - Name of the skill being evaluated
 * @param diff - Optional unified diff for JiT-style evaluation
 */
export function buildEvalPrompt(
  skillContent: string,
  skillName: string,
  diff?: string,
): string {
  let prompt = `You are evaluating a pi coding agent skill named "${skillName}".

${RUBRIC}

## Skill Content

\`\`\`markdown
${skillContent}
\`\`\`
`;

  if (diff) {
    prompt += `
## Changes (Diff)

Focus your evaluation on what changed. Flag any issues introduced by the modifications.

\`\`\`diff
${diff}
\`\`\`
`;
  }

  prompt += `
## Output Format

Respond with a JSON object (no markdown wrapping needed, but it's okay if you use a code block):

{
  "verdict": "pass" | "fail" | "needs-revision",
  "findings": [
    {
      "category": "clarity" | "completeness" | "context-efficiency" | "correctness" | "jit-catch",
      "severity": "error" | "warning" | "info",
      "message": "Specific, actionable finding"
    }
  ]
}

Rules:
- "pass" = the stated capability is usable and concise
- "needs-revision" = a material in-scope issue reduces reliability, safety, or usability
- "fail" = errors prevent the skill from working
- Do not request copied facts or out-of-scope detail; use "info" for genuinely optional suggestions
- Be concise and actionable. Use "jit-catch" only when a diff is provided.`;

  return prompt;
}

/**
 * Parse the LLM's evaluation response into a structured result.
 * Handles JSON in code blocks, raw JSON, and unparseable responses.
 */
export function parseEvalResponse(
  response: string,
  skillName: string,
  modelConfig: EvalModelConfig,
  usage: TokenUsage,
): EvaluationResult {
  const tokenEconomy: TokenEconomy = {
    provider: modelConfig.provider,
    model: modelConfig.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    estimatedCost: estimateCost(
      modelConfig,
      usage.inputTokens,
      usage.outputTokens,
    ),
    costModel: modelConfig.costModel,
  };

  // Try to extract JSON — from code block or raw
  let json: RawEvalResponse | null = null;
  const codeBlockMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const jsonStr = codeBlockMatch ? codeBlockMatch[1] : response;

  const tryParse = (s: string): RawEvalResponse | null => {
    try {
      const parsed: unknown = JSON.parse(s);
      if (parsed && typeof parsed === "object" && "verdict" in parsed) {
        return parsed as RawEvalResponse;
      }
    } catch { /* not valid JSON */ }
    return null;
  };

  json = tryParse(jsonStr.trim());
  if (!json) {
    const objectMatch = response.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
    if (objectMatch) json = tryParse(objectMatch[0]);
  }

  if (!json) {
    return {
      skillName,
      evaluatedAt: new Date().toISOString(),
      verdict: "fail",
      findings: [
        {
          category: "correctness",
          severity: "error",
          message: `Evaluator response was not parseable as JSON. Raw response: ${response.slice(0, 200)}`,
        },
      ],
      tokenEconomy,
    };
  }

  // Validate verdict
  type EvalVerdict = "pass" | "fail" | "needs-revision";
  const rawVerdict = json.verdict;
  const verdict: EvalVerdict = typeof rawVerdict === "string" && VALID_VERDICTS.has(rawVerdict)
    ? (rawVerdict as EvalVerdict)
    : "fail";

  // Validate and filter findings
  const findings: EvaluationFinding[] = [];
  if (Array.isArray(json.findings)) {
    for (const f of json.findings) {
      if (
        f &&
        typeof f.message === "string" &&
        VALID_CATEGORIES.has(f.category) &&
        VALID_SEVERITIES.has(f.severity)
      ) {
        findings.push({
          category: f.category,
          severity: f.severity,
          message: f.message,
        });
      }
    }
  }

  return {
    skillName,
    evaluatedAt: new Date().toISOString(),
    verdict,
    findings,
    tokenEconomy,
  };
}

/**
 * Estimate cost for a given model config and token usage.
 */
export function estimateCost(
  config: EvalModelConfig,
  inputTokens: number,
  outputTokens: number,
): number {
  if (config.costModel === "self-hosted") return 0;
  return inputTokens * config.costPerInputToken + outputTokens * config.costPerOutputToken;
}
