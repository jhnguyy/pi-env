/**
 * LLM-as-judge evaluator for skills.
 *
 * Design:
 * - Provider-agnostic: accepts model config, doesn't hardcode Anthropic
 * - Token-economy-aware: tracks cost per evaluation, distinguishes API vs self-hosted
 * - Goal- and diff-aware: evaluates the user's requested outcome and local changes
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
  costPerMillionInputTokens: number;
  costPerMillionOutputTokens: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  actualCost?: number;
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
const MAX_FINDINGS = 3;
const MAX_FINDING_MESSAGE_LENGTH = 500;

const RUBRIC = `## Evaluation Rubric

The user goal controls scope. Treat the description as activation metadata, not a demand to add routine mechanics. Assume a competent coding agent can use standard tools and repository guidance. Prefer narrowing, deleting, or delegating before adding instructions.

### clarity
Can an agent achieve the user goal without inventing non-obvious requirements? Keep only decisions, constraints, and retrieval steps that the skill must own.

### completeness
Is the user goal minimally supported? Flag omitted detail only when the omission creates a concrete reliability, safety, or usability failure that an authoritative source cannot resolve.

### context-efficiency
Does every instruction earn its recurring cost? Prefer authoritative sources over copied facts and direct instructions over unnecessary indexes or references.

### correctness
Are stable claims accurate and changing facts retrieved at task time? Do references resolve where used?

### jit-catch (only when diff provided)
Do the local changes preserve scope, consistency, and context efficiency without leaving broken references?`;

/**
 * Build the evaluation prompt for the LLM judge.
 *
 * @param skillContent - Full content of SKILL.md
 * @param skillName - Name of the skill being evaluated
 * @param goal - User-requested outcome that defines the evaluation scope
 * @param diff - Optional local SKILL.md diff against Git HEAD
 */
export function buildEvalPrompt(
  skillContent: string,
  skillName: string,
  goal: string,
  diff?: string,
): string {
  let prompt = `You are evaluating a pi coding agent skill named "${skillName}".

${RUBRIC}

## User Goal

${goal}

## Skill Content

\`\`\`markdown
${skillContent}
\`\`\`
`;

  if (diff) {
    prompt += `
## Changes (Diff)

Focus on issues introduced by these local changes. Use the full skill only to detect contradictions or lost requirements.

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
- The verdict and findings are advisory. The user decides whether each finding applies.
- "pass" = the user goal is supported and no material finding remains
- "needs-revision" = a material goal-relative issue reduces reliability, safety, or usability
- "fail" = errors prevent the skill from working
- Do not request routine tool mechanics, copied facts, or out-of-scope detail
- For each finding, state the concrete failure and the smallest corrective action
- Return no more than three findings. Use "info" only for genuinely optional suggestions
- Be concise. Use "jit-catch" only when a diff is provided.`;

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
    estimatedCost:
      usage.actualCost ?? estimateCost(modelConfig, usage.inputTokens, usage.outputTokens),
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
    } catch {
      /* not valid JSON */
    }
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
  const verdict: EvalVerdict =
    typeof rawVerdict === "string" && VALID_VERDICTS.has(rawVerdict)
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
          message: f.message.slice(0, MAX_FINDING_MESSAGE_LENGTH),
        });
        if (findings.length >= MAX_FINDINGS) break;
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
  return (
    (inputTokens / 1_000_000) * config.costPerMillionInputTokens +
    (outputTokens / 1_000_000) * config.costPerMillionOutputTokens
  );
}
