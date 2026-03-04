import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { describeIfEnabled } from "../../__tests__/test-utils";
import {
  buildEvalPrompt,
  parseEvalResponse,
  estimateCost,
  type EvalModelConfig,
} from "../evaluator";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "skill-evaluator-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function createSkillContent(name: string, body: string): string {
  return `---
name: ${name}
description: A skill for ${name} tasks. Use when working with ${name}.
---

${body}`;
}

const testModelConfig: EvalModelConfig = {
  provider: "anthropic",
  model: "claude-haiku-4-5-20250929",
  costModel: "api",
  costPerInputToken: 0.0000008,
  costPerOutputToken: 0.000004,
};

const selfHostedConfig: EvalModelConfig = {
  provider: "ollama",
  model: "llama3.2",
  costModel: "self-hosted",
  costPerInputToken: 0,
  costPerOutputToken: 0,
};

describeIfEnabled("skill-builder", "Evaluator", () => {
  // ─── Prompt Construction ───────────────────────────────────────

  describe("buildEvalPrompt", () => {
    it("includes the skill content in the prompt", () => {
      const content = createSkillContent("my-tool", "# My Tool\n\nDoes things.");
      const prompt = buildEvalPrompt(content, "my-tool");
      expect(prompt).toContain("my-tool");
      expect(prompt).toContain("Does things.");
    });

    it("includes evaluation rubric categories", () => {
      const content = createSkillContent("my-tool", "# My Tool");
      const prompt = buildEvalPrompt(content, "my-tool");
      expect(prompt).toContain("clarity");
      expect(prompt).toContain("completeness");
      expect(prompt).toContain("context-efficiency");
    });

    it("requests structured JSON output", () => {
      const content = createSkillContent("my-tool", "# My Tool");
      const prompt = buildEvalPrompt(content, "my-tool");
      expect(prompt).toMatch(/json/i);
    });

    it("includes diff context when provided", () => {
      const content = createSkillContent("my-tool", "# My Tool\n\nNew content.");
      const diff = "- Old line\n+ New content.";
      const prompt = buildEvalPrompt(content, "my-tool", diff);
      expect(prompt).toContain("Old line");
      expect(prompt).toContain("diff");
    });
  });

  // ─── Response Parsing ─────────────────────────────────────────

  describe("parseEvalResponse", () => {
    it("parses a valid JSON evaluation response", () => {
      const response = JSON.stringify({
        verdict: "pass",
        findings: [
          {
            category: "clarity",
            severity: "info",
            message: "Instructions are clear and specific.",
          },
        ],
      });
      const result = parseEvalResponse(response, "my-tool", testModelConfig, {
        inputTokens: 500,
        outputTokens: 100,
      });
      expect(result.verdict).toBe("pass");
      expect(result.findings).toHaveLength(1);
      expect(result.skillName).toBe("my-tool");
    });

    it("extracts JSON from markdown code blocks", () => {
      const response = `Here's my evaluation:

\`\`\`json
{
  "verdict": "needs-revision",
  "findings": [
    {
      "category": "context-efficiency",
      "severity": "warning",
      "message": "SKILL.md is too large. Use index pattern."
    }
  ]
}
\`\`\``;
      const result = parseEvalResponse(response, "my-tool", testModelConfig, {
        inputTokens: 500,
        outputTokens: 200,
      });
      expect(result.verdict).toBe("needs-revision");
      expect(result.findings).toHaveLength(1);
    });

    it("returns fail verdict on unparseable response", () => {
      const result = parseEvalResponse(
        "I couldn't evaluate this properly.",
        "my-tool",
        testModelConfig,
        { inputTokens: 500, outputTokens: 50 },
      );
      expect(result.verdict).toBe("fail");
      expect(result.findings.some((f) => f.category === "correctness")).toBe(true);
    });

    it("populates token economy from model config", () => {
      const response = JSON.stringify({
        verdict: "pass",
        findings: [],
      });
      const result = parseEvalResponse(response, "my-tool", testModelConfig, {
        inputTokens: 1000,
        outputTokens: 200,
      });
      expect(result.tokenEconomy.provider).toBe("anthropic");
      expect(result.tokenEconomy.model).toBe("claude-haiku-4-5-20250929");
      expect(result.tokenEconomy.inputTokens).toBe(1000);
      expect(result.tokenEconomy.outputTokens).toBe(200);
      expect(result.tokenEconomy.costModel).toBe("api");
    });

    it("validates verdict is one of pass/fail/needs-revision", () => {
      const response = JSON.stringify({
        verdict: "maybe",
        findings: [],
      });
      const result = parseEvalResponse(response, "my-tool", testModelConfig, {
        inputTokens: 500,
        outputTokens: 100,
      });
      // Invalid verdict should be treated as fail
      expect(result.verdict).toBe("fail");
    });

    it("validates finding categories", () => {
      const response = JSON.stringify({
        verdict: "pass",
        findings: [
          { category: "invented-category", severity: "info", message: "Whatever" },
          { category: "clarity", severity: "info", message: "Good" },
        ],
      });
      const result = parseEvalResponse(response, "my-tool", testModelConfig, {
        inputTokens: 500,
        outputTokens: 100,
      });
      // Should keep valid findings, drop invalid
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].category).toBe("clarity");
    });
  });

  // ─── Cost Estimation ──────────────────────────────────────────

  describe("estimateCost", () => {
    it("calculates API cost from token counts", () => {
      const cost = estimateCost(testModelConfig, 1000, 200);
      // 1000 * 0.0000008 + 200 * 0.000004 = 0.0008 + 0.0008 = 0.0016
      expect(cost).toBeCloseTo(0.0016, 6);
    });

    it("returns zero for self-hosted models", () => {
      const cost = estimateCost(selfHostedConfig, 1000, 200);
      expect(cost).toBe(0);
    });

    it("handles zero tokens", () => {
      const cost = estimateCost(testModelConfig, 0, 0);
      expect(cost).toBe(0);
    });
  });

  // ─── JiT-Style Diff Evaluation ────────────────────────────────

  describe("diff-aware evaluation", () => {
    it("buildEvalPrompt without diff omits diff section", () => {
      const content = createSkillContent("my-tool", "# My Tool");
      const prompt = buildEvalPrompt(content, "my-tool");
      expect(prompt).not.toContain("## Changes");
    });

    it("buildEvalPrompt with diff includes diff-aware instructions", () => {
      const content = createSkillContent("my-tool", "# My Tool\n\nUpdated.");
      const diff = "@@ -1,3 +1,3 @@\n- old instruction\n+ Updated.";
      const prompt = buildEvalPrompt(content, "my-tool", diff);
      expect(prompt).toContain("Changes");
      expect(prompt).toContain("old instruction");
      // Should ask evaluator to focus on what changed
      expect(prompt).toMatch(/change|diff|modif/i);
    });
  });
});
