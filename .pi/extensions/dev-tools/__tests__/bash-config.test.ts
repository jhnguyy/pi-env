import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// LSP responses do not expose these defaults or which initialization keys were supplied.
const config = createRequire(import.meta.url)("bash-language-server/out/config.js");

describe("Bash Language Server configuration compatibility", () => {
  it("applies nested formatter defaults when configuration is absent", () => {
    expect(config.getDefaultConfiguration().shfmt).toMatchObject({
      path: "shfmt",
      additionalArguments: [],
      ignoreEditorconfig: false,
      languageDialect: "auto",
    });
  });

  it.each([{}, { shfmt: {} }, { shfmt: { path: "custom-shfmt" } }])(
    "does not add initialization overrides to %j",
    (input) => {
      expect(config.InitializationOptionsSchema.parse(input)).toEqual(input);
    },
  );

  it("keeps explicit false and zero values and normalizes argument lists", () => {
    expect(config.InitializationOptionsSchema.parse({
      backgroundAnalysisMaxFiles: 0,
      shellcheckExternalSources: false,
      shellcheckArguments: " -e  1 ",
      shfmt: { additionalArguments: [" -i ", "", "2"] },
    })).toEqual({
      backgroundAnalysisMaxFiles: 0,
      shellcheckExternalSources: false,
      shellcheckArguments: ["-e", "1"],
      shfmt: { additionalArguments: ["-i", "2"] },
    });
  });

  it("rejects invalid configuration and initialization values", () => {
    for (const schema of [config.ConfigSchema, config.InitializationOptionsSchema]) {
      expect(schema.safeParse({ backgroundAnalysisMaxFiles: -1 }).success).toBe(false);
      expect(schema.safeParse({ shfmt: { languageDialect: "invalid" } }).success).toBe(false);
    }
  });
});
