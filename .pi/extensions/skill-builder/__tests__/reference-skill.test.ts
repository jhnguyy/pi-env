import { expect, it } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { getReferenceDirs, getReferenceSkillIndex, listReferenceSkillNames } from "../index";

describeIfEnabled("skill-builder", "reference skills", () => {
  it("discovers package reference skills", () => {
    expect(getReferenceDirs().some((dir) => dir.endsWith(".agents/skills/reference"))).toBe(true);
    expect(listReferenceSkillNames()).toEqual(expect.arrayContaining(["effect-typescript", "planning"]));
  });

  it("indexes reference skills by frontmatter name and filename", () => {
    const index = getReferenceSkillIndex();
    const byName = index.get("effect-typescript");
    const byFile = index.get("planning");

    expect(byName?.name).toBe("effect-typescript");
    expect(byName?.filePath.endsWith(".agents/skills/reference/effect-typescript.md")).toBe(true);
    expect(byFile?.name).toBe("planning");
    expect(byFile?.filePath.endsWith(".agents/skills/reference/planning.md")).toBe(true);
  });
});
