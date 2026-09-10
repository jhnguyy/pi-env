import { expect, it } from "vitest";

import { describeIfEnabled } from "../../__tests__/test-utils";
import { renderTemplate } from "../templates";

describeIfEnabled("skill-builder", "Templates", () => {
  it("keeps the activation description out of the with-index body", () => {
    const description = "API documentation.";
    const result = renderTemplate({
      name: "api-docs",
      description,
      template: "with-index",
    });

    expect(result.files["SKILL.md"].match(new RegExp(description, "g"))).toHaveLength(1);
  });
});
