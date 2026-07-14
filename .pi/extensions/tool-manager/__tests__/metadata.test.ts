import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const lazyFiles = [
  ".pi/extensions/analyze/index.ts",
  ".pi/extensions/web-context/index.ts",
  ".pi/extensions/introspection/index.ts",
];

describe("lazy tool metadata", () => {
  it("omits active-only prompt metadata from lazy tools", () => {
    for (const file of lazyFiles) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toContain("promptSnippet");
      expect(source).not.toContain("promptGuidelines");
    }
  });
});
