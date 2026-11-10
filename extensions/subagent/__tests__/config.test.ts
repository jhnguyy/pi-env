import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SUBAGENT_LIMITS,
  resolveSubagentRuntimeConfig,
  SubagentSessionStorage,
  SubagentSettingsSchema,
} from "../config";

describe("subagent session storage configuration", () => {
  it("defaults to nested child storage", () => {
    expect(resolveSubagentRuntimeConfig({}).sessionStorage).toBe(SubagentSessionStorage.Nested);
  });

  it("accepts the longest native timer deadline and defaults overflowing deadlines", () => {
    expect(resolveSubagentRuntimeConfig({ maxRunMs: 2_147_483_647 }).maxRunMs).toBe(2_147_483_647);
    expect(resolveSubagentRuntimeConfig({ maxRunMs: 2_147_483_648 }).maxRunMs).toBe(
      DEFAULT_SUBAGENT_LIMITS.maxRunMs,
    );
  });

  it("accepts sibling storage as a compatibility override", () => {
    const settings = Schema.decodeUnknownSync(SubagentSettingsSchema)({
      sessionStorage: "sibling",
    });

    expect(resolveSubagentRuntimeConfig(settings).sessionStorage).toBe(
      SubagentSessionStorage.Sibling,
    );
  });
});
