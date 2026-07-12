import { describe, expect, it } from "vitest";
import {
  compareV3EffectUsage,
  countV3EffectUsage,
  EFFECT_V4_MIGRATION_BASELINE,
} from "../check-effect-v4-readiness.mjs";

describe("Effect v4 migration readiness", () => {
  it("counts v3-only APIs and schema call shapes without matching comments or strings", () => {
    const counts = countV3EffectUsage(
      "src/example.ts",
      `
      import { Context, Effect, Either, Schema } from "effect";
      // Effect.catchAll and Schema.Record({ key, value })
      const text = "Effect.either";
      const service = Context.GenericTag("service");
      const callback = Effect.async(() => undefined);
      const recovered = Effect.catchAll(effect, handler);
      const result = Effect.either(effect);
      const record = Schema.Record({ key: Schema.String, value: Schema.Unknown });
      const union = Schema.Union(Schema.String, Schema.Number);
      const literal = Schema.Literal("a", "b");
      const decoded = Schema.decodeUnknown(schema);
      type Output = Schema.Schema.Type<typeof schema>;
      Either.isLeft(value);
    `,
    );

    expect(counts).toMatchObject({
      "Context.GenericTag": 1,
      "Effect.async": 1,
      "Effect.catchAll": 1,
      "Effect.either": 1,
      "Effect Either reference": 2,
      "Schema.Literal variadic": 1,
      "Schema.Record object form": 1,
      "Schema.Schema namespace": 1,
      "Schema.Union variadic": 1,
      "Schema.decodeUnknown": 1,
    });
  });

  it("tracks renamed imports and ignores unrelated local Either identifiers", () => {
    const counts = countV3EffectUsage(
      "src/aliases.ts",
      `
      import { Effect as E, Either as Choice, Schema as S } from "effect";
      const Either = "not Effect";
      E.either(effect);
      Choice.isLeft(value);
      S.Record({ key: S.String, value: S.Unknown });
    `,
    );

    expect(counts["Effect.either"]).toBe(1);
    expect(counts["Effect Either reference"]).toBe(2);
    expect(counts["Schema.Record object form"]).toBe(1);

    const direct = countV3EffectUsage(
      "src/direct.ts",
      'import { either as resultish } from "effect/Effect";',
    );
    expect(direct["untracked Effect import shape"]).toBe(1);
  });

  it("requires the checked-in baseline to move monotonically with the source", () => {
    expect(compareV3EffectUsage(EFFECT_V4_MIGRATION_BASELINE)).toEqual([]);
    expect(compareV3EffectUsage({ ...EFFECT_V4_MIGRATION_BASELINE, "Effect.either": 48 })).toEqual([
      "Effect.either: migration debt grew from 47 to 48",
    ]);
    expect(compareV3EffectUsage({ ...EFFECT_V4_MIGRATION_BASELINE, "Effect.either": 46 })).toEqual([
      "Effect.either: baseline is stale (47); lower it to 46",
    ]);
  });
});
