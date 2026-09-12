import { describe, expect, it } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import {
  parseEvalResponse,
  estimateCost,
  type EvalModelConfig,
} from "../evaluator";

const testModelConfig: EvalModelConfig = {
  provider: "anthropic",
  model: "claude-haiku-4-5-20250929",
  costModel: "api",
  costPerMillionInputTokens: 0.8,
  costPerMillionOutputTokens: 4,
};

const selfHostedConfig: EvalModelConfig = {
  provider: "ollama",
  model: "llama3.2",
  costModel: "self-hosted",
  costPerMillionInputTokens: 0,
  costPerMillionOutputTokens: 0,
};

describeIfEnabled("skill-builder", "Evaluator", () => {
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
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].category).toBe("clarity");
    });

    it("bounds advisory findings and message length", () => {
      const response = JSON.stringify({
        verdict: "needs-revision",
        findings: Array.from({ length: 4 }, (_, index) => ({
          category: "clarity",
          severity: "warning",
          message: `${index}:${"x".repeat(600)}`,
        })),
      });
      const result = parseEvalResponse(response, "my-tool", testModelConfig, {
        inputTokens: 500,
        outputTokens: 100,
      });
      expect(result.findings).toHaveLength(3);
      expect(result.findings.every((finding) => finding.message.length <= 500)).toBe(true);
    });
  });

  // ─── Cost Estimation ──────────────────────────────────────────

  describe("estimateCost", () => {
    it("calculates API cost from token counts", () => {
      const cost = estimateCost(testModelConfig, 1000, 200);
      // (1000 / 1M) * 0.8 + (200 / 1M) * 4 = 0.0016
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
});
