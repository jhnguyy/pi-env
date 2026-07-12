import { expect, it } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { getReferenceDirs, getReferenceSkillIndex, listReferenceSkillNames } from "../index";

describeIfEnabled("skill-builder", "reference skills", () => {
  it("discovers package reference skills", () => {
    expect(getReferenceDirs().some((dir) => dir.endsWith(".agents/skills/reference"))).toBe(true);
    expect(listReferenceSkillNames()).toContain("planning");
  });

  it("indexes reference skills by filename", () => {
    const byFile = getReferenceSkillIndex().get("planning");

    expect(byFile?.name).toBe("planning");
    expect(byFile?.filePath.endsWith(".agents/skills/reference/planning.md")).toBe(true);
  });
});
