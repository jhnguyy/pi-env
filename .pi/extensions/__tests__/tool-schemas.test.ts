import { validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { Static } from "typebox";
import { analyzeToolSchema, type AnalyzeToolInput } from "../analyze/index";
import { NOTES_PARAMETERS } from "../notes/contract";
import {
  FindingInputSchema,
  PrReviewParamsSchema,
  type PrReviewParams,
  type ReviewCommand,
  type Severity,
} from "../review/schema";
import type { ScopeMode } from "../../../src/analyze/model";

function validate(
  parameters: typeof PrReviewParamsSchema | typeof analyzeToolSchema | typeof NOTES_PARAMETERS,
  args: Record<string, string | number | string[]>,
) {
  return validateToolArguments(
    { name: "sample", description: "Schema boundary fixture", parameters },
    { type: "toolCall", id: "schema-call", name: "sample", arguments: args },
  );
}

describe("TypeBox schemas at Pi's JSON Schema validation boundary", () => {
  it("retains literal unions rather than widening enum inputs to strings", () => {
    expectTypeOf<PrReviewParams["action"]>().toExtend<ReviewCommand>();
    expectTypeOf<AnalyzeToolInput["scope"]>().toExtend<ScopeMode | undefined>();
    expectTypeOf<Static<typeof FindingInputSchema>["severity"]>().toExtend<
      (typeof Severity)[keyof typeof Severity]
    >();
    expectTypeOf<"delete">().not.toExtend<PrReviewParams["action"]>();
    expectTypeOf<"not-a-scope">().not.toExtend<AnalyzeToolInput["scope"]>();
    expectTypeOf<"not-a-severity">().not.toExtend<Static<typeof FindingInputSchema>["severity"]>();
  });

  it("keeps annotated string enums flat for provider adapters", () => {
    expect(PrReviewParamsSchema.properties.action).toMatchObject({
      type: "string",
      enum: expect.arrayContaining(["get"]),
    });
    expect(PrReviewParamsSchema.properties.action).not.toHaveProperty("anyOf");
    expect(PrReviewParamsSchema.properties.feedback).toMatchObject({
      type: "string",
      enum: expect.arrayContaining(["all"]),
    });
    expect(PrReviewParamsSchema.properties.feedback).not.toHaveProperty("anyOf");
  });

  it("accepts valid enums and rejects invalid values through Pi's public validator", () => {
    expect(validate(PrReviewParamsSchema, { command: "pr", action: "get" })).toMatchObject({
      action: "get",
    });
    expect(validate(NOTES_PARAMETERS, { collection: "inbox", action: "read" })).toMatchObject({
      action: "read",
    });
    expect(validate(analyzeToolSchema, { worktree: "/fixture", scope: "diff" })).toMatchObject({
      scope: "diff",
    });
    expect(() => validate(PrReviewParamsSchema, { command: "pr", action: "delete" })).toThrow();
    expect(() =>
      validate(NOTES_PARAMETERS, { collection: "inbox", action: "not-a-notes-action" }),
    ).toThrow();
    expect(() =>
      validate(analyzeToolSchema, { worktree: "/fixture", scope: "not-a-scope" }),
    ).toThrow();
  });

  it("accepts numeric page sizes within the repository limit and rejects oversized pages", () => {
    expect(validate(PrReviewParamsSchema, { command: "pr", action: "get", pageSize: 4 })).toEqual({
      command: "pr",
      action: "get",
      pageSize: 4,
    });
    expect(() =>
      validate(PrReviewParamsSchema, { command: "pr", action: "get", pageSize: 6 }),
    ).toThrow();
  });

  it("accepts known checks in arrays and rejects unknown checks", () => {
    expect(
      validate(analyzeToolSchema, { worktree: "/fixture", checks: ["async-risk"] }),
    ).toMatchObject({ checks: ["async-risk"] });
    expect(() =>
      validate(analyzeToolSchema, { worktree: "/fixture", checks: ["unknown-check"] }),
    ).toThrow();
  });
});
