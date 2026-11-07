import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  resolveSubagentRuntimeConfig,
  SubagentSessionStorage,
  SubagentSettingsSchema,
} from "../config";

describe("subagent session storage configuration", () => {
  it("defaults to nested child storage", () => {
    expect(resolveSubagentRuntimeConfig({}).sessionStorage).toBe(SubagentSessionStorage.Nested);
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
