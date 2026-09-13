import { describe, expect, it } from "vitest";
import { isOutsideWorkspace } from "../workspace-path.js";

describe("workspace path containment", () => {
  it.each(["../outside.ts", "/outside.ts", "D:/outside.ts", "D:\\outside.ts"])(
    "rejects an outside relative result on every supported path form: %s",
    (path) => {
      expect(isOutsideWorkspace(path)).toBe(true);
    },
  );

  it("keeps a normal workspace-relative result", () => {
    expect(isOutsideWorkspace("src/analyze/policy.ts")).toBe(false);
  });
});
