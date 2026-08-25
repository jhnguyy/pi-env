import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  PR_REVIEW_APPROVAL_ANNOTATION,
  resolvePrReviewModelPolicy,
  type AgentSettingsLike,
  type ReviewModelPolicyError,
} from "../model-policy.ts";

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
function settings(...approved: string[]): AgentSettingsLike {
  return {
    modelAnnotations: Object.fromEntries(
      approved.map((id) => [id, [PR_REVIEW_APPROVAL_ANNOTATION]]),
    ),
  };
}

const models = [model("anthropic", "claude"), model("openai", "gpt")];

describe("resolvePrReviewModelPolicy", () => {
  it("rejects an available roster without exact model approval", () => {
    expect(() =>
      resolvePrReviewModelPolicy(
        { modelAnnotations: { "anthropic/claude": ["reviewer-extra"] } },
        models,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<ReviewModelPolicyError>>({ code: "no_approved_models" }),
    );
  });

  it("assigns every role when only one approved model is available", () => {
    const result = resolvePrReviewModelPolicy(settings("openai/model"), [model("openai", "model")]);
    expect(new Set(Object.values(result.assignments).map((assignment) => assignment.fqid))).toEqual(
      new Set(["openai/model"]),
    );
  });

  it("returns deterministic complete assignments from the bounded approved roster", () => {
    const available = [
      model("openai", "gpt-5"),
      model("anthropic", "claude-4"),
      model("google", "gemini-2.5"),
    ];
    const approved = settings("openai/gpt-5", "anthropic/claude-4", "google/gemini-2.5");
    const result = resolvePrReviewModelPolicy(approved, available);
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
    expect(result.approvedRoster.map((candidate) => candidate.fqid)).toEqual([
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
    expect(resolvePrReviewModelPolicy(approved, [...available].reverse()).assignments).toEqual(
      result.assignments,
    );
  });

  it("rejects unknown, unavailable, and unapproved pins", () => {
    expect(() =>
      resolvePrReviewModelPolicy(settings("anthropic/claude", "openai/gpt"), models, {
        invented: "openai/gpt",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ReviewModelPolicyError>>({ code: "invalid_pin" }),
    );
    expect(() =>
      resolvePrReviewModelPolicy(settings("anthropic/claude", "openai/gpt"), models, {
        security: "google/gemini",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ReviewModelPolicyError>>({ code: "invalid_pin" }),
    );
    expect(() =>
      resolvePrReviewModelPolicy(
        settings("anthropic/claude", "openai/gpt"),
        [...models, model("google", "gemini")],
        { security: "google/gemini" },
      ),
    ).toThrowError(
      expect.objectContaining<Partial<ReviewModelPolicyError>>({ code: "unapproved_model" }),
    );
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
    const result = resolvePrReviewModelPolicy(
      settings("anthropic/smart-name", "openai/plain-name"),
      available,
    );
    expect(result.assignments["reading-plan"].reasoning).toBe("high");
    expect(result.assignments.intent.reasoning).toBe("medium");
  });
});
