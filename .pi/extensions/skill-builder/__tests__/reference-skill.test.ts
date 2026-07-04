import { expect, it } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { getReferenceDirs, getReferenceSkillIndex, listReferenceSkillNames } from "../index";

describeIfEnabled("skill-builder", "reference skills", () => {
  it("discovers package reference skills", () => {
    expect(getReferenceDirs().some((dir) => dir.endsWith(".agents/skills/reference"))).toBe(true);
    expect(listReferenceSkillNames()).toContain("effect-typescript");
  });

  it("indexes reference skills by frontmatter name and filename", () => {
    const index = getReferenceSkillIndex();
    const byName = index.get("effect-typescript");

    expect(byName?.name).toBe("effect-typescript");
    expect(byName?.filePath.endsWith(".agents/skills/reference/effect-typescript.md")).toBe(true);
  });
});
