import { validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { Static } from "typebox";
import { analyzeToolSchema, type AnalyzeToolInput } from "../analyze/index";
import { NOTES_PARAMETERS } from "../notes/contract";
import { FindingInputSchema, PrReviewParamsSchema, type PrReviewParams } from "../review/schema";

function validate(
  parameters: typeof PrReviewParamsSchema | typeof analyzeToolSchema | typeof NOTES_PARAMETERS,
  args: Record<string, string | number | null>,
) {
  return validateToolArguments(
    { name: "sample", description: "Schema boundary fixture", parameters },
    { type: "toolCall", id: "schema-call", name: "sample", arguments: args },
  );
}

describe("TypeBox schemas at Pi's JSON Schema validation boundary", () => {
  it("retains literal unions rather than widening enum inputs to strings", () => {
    expectTypeOf<PrReviewParams["action"]>().toEqualTypeOf<"get" | "create">();
    expectTypeOf<AnalyzeToolInput["scope"]>().toEqualTypeOf<"diff" | "paths" | "all" | undefined>();
    expectTypeOf<Static<typeof FindingInputSchema>["severity"]>().toEqualTypeOf<
      "low" | "medium" | "serious" | "blocking"
    >();
  });

  it("keeps annotated string enums flat for provider adapters", () => {
    expect(PrReviewParamsSchema.properties.action).toMatchObject({
      type: "string",
      enum: ["get", "create"],
    });
    expect(PrReviewParamsSchema.properties.action).not.toHaveProperty("anyOf");
    expect(PrReviewParamsSchema.properties.feedback).toMatchObject({
      type: "string",
      enum: ["all", "conversation", "reviews", "inline"],
      description: expect.stringContaining("Feedback category"),
    });
  });

  it("rejects invalid enum actions through Pi's public validator", () => {
    expect(() => validate(PrReviewParamsSchema, { command: "pr", action: "delete" })).toThrow();
    expect(() => validate(NOTES_PARAMETERS, { action: "not-a-notes-action" })).toThrow();
    expect(() =>
      validate(analyzeToolSchema, { worktree: "/fixture", scope: "not-a-scope" }),
    ).toThrow();
  });

  it("coerces numeric strings and drops optional nulls before execution", () => {
    expect(
      validate(PrReviewParamsSchema, { command: "pr", action: "get", pageSize: "4", cursor: null }),
    ).toEqual({ command: "pr", action: "get", pageSize: 4 });
    expect(() =>
      validate(PrReviewParamsSchema, { command: "pr", action: "get", pageSize: "6" }),
    ).toThrow();
  });

  it("coerces a scalar string enum into an array without accepting unknown values", () => {
    expect(
      validate(analyzeToolSchema, { worktree: "/fixture", checks: "async-risk" }),
    ).toMatchObject({ checks: ["async-risk"] });
    expect(() =>
      validate(analyzeToolSchema, { worktree: "/fixture", checks: "unknown-check" }),
    ).toThrow();
  });
});
