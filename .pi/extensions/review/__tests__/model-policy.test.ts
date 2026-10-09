import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { resolvePrReviewModelPolicy, type ReviewModelPolicyError } from "../model-policy.ts";

function model(
  provider: string,
  id: string,
  options: Partial<Model<"openai-responses">> = {},
): Model<"openai-responses"> {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider,
    baseUrl: `https://${provider}.example.com`,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 1000,
    ...options,
  };
}
const models = [model("anthropic", "claude"), model("openai", "gpt")];

describe("resolvePrReviewModelPolicy", () => {
  it("requires an available model roster", () => {
    expect(() => resolvePrReviewModelPolicy([])).toThrow(
      expect.objectContaining<Partial<ReviewModelPolicyError>>({ code: "no_available_models" }),
    );
  });

  it("uses all available models without reviewer annotations", () => {
    const result = resolvePrReviewModelPolicy(models);
    expect(result.availableRoster.map((candidate) => candidate.fqid)).toEqual([
      "anthropic/claude",
      "openai/gpt",
    ]);
  });

  it("assigns every role when only one model is available", () => {
    const result = resolvePrReviewModelPolicy([model("openai", "model")]);
    expect(new Set(Object.values(result.assignments).map((assignment) => assignment.fqid))).toEqual(
      new Set(["openai/model"]),
    );
  });

  it("returns deterministic complete assignments from the available roster", () => {
    const available = [
      model("openai", "gpt-5"),
      model("anthropic", "claude-4"),
      model("google", "gemini-2.5"),
    ];
    const result = resolvePrReviewModelPolicy(available);
    expect(Object.keys(result.assignments)).toEqual([
      "reading-plan",
      "correctness",
      "intent",
      "maintainability",
      "tests",
      "security",
      "whole-change",
      "synthesis",
    ]);
    expect(result.availableRoster.map((candidate) => candidate.fqid)).toEqual([
      "anthropic/claude-4",
      "google/gemini-2.5",
      "openai/gpt-5",
    ]);
    expect(
      Object.fromEntries(
        Object.entries(result.assignments).map(([role, assignment]) => [role, assignment.fqid]),
      ),
    ).toEqual({
      "reading-plan": "anthropic/claude-4",
      correctness: "anthropic/claude-4",
      intent: "google/gemini-2.5",
      maintainability: "openai/gpt-5",
      tests: "anthropic/claude-4",
      security: "google/gemini-2.5",
      "whole-change": "openai/gpt-5",
      synthesis: "openai/gpt-5",
    });
    expect(resolvePrReviewModelPolicy([...available].reverse()).assignments).toEqual(
      result.assignments,
    );
  });

  it("rejects unknown and unavailable pins while allowing any available model", () => {
    expect(() =>
      resolvePrReviewModelPolicy(models, {
        invented: "openai/gpt",
      }),
    ).toThrow(
      expect.objectContaining<Partial<ReviewModelPolicyError>>({ code: "invalid_pin" }),
    );
    expect(() =>
      resolvePrReviewModelPolicy(models, {
        security: "google/gemini",
      }),
    ).toThrow(
      expect.objectContaining<Partial<ReviewModelPolicyError>>({ code: "invalid_pin" }),
    );
    expect(
      resolvePrReviewModelPolicy([...models, model("google", "gemini")], {
        security: "google/gemini",
      }).assignments.security.fqid,
    ).toBe("google/gemini");
  });

  it("derives the highest reasoning level from model metadata", () => {
    const available = [
      model("anthropic", "smart-name", {
        thinkingLevelMap: { xhigh: null, max: null },
      }),
      model("openai", "plain-name", {
        thinkingLevelMap: { high: null, xhigh: null, max: null },
      }),
    ];
    const result = resolvePrReviewModelPolicy(available);
    expect(result.assignments["reading-plan"].reasoning).toBe("high");
    expect(result.assignments.intent.reasoning).toBe("medium");
  });
});
