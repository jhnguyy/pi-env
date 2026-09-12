import { expect, it } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { executeReferenceSkill } from "../index";

describeIfEnabled("skill-builder", "reference_skill", () => {
  it("lists and reads packaged reference skills", () => {
    const listed = executeReferenceSkill({});
    expect(listed.content[0]?.text).toContain("planning");

    const loaded = executeReferenceSkill({ name: "planning" });
    expect(loaded.content[0]?.text).toContain("# Planning");
  });
});
