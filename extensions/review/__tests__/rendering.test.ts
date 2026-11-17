import "../../__tests__/tui-setup";
import { expect, it } from "vitest";
import { componentText as textOf } from "../../__tests__/rendering";
import { renderReviewCall } from "../render";

const theme = { fg: (style: string, text: string) => `<${style}>${text}</${style}>` };
it("renders the review operation and pull request URL compactly", () => {
  expect(
    textOf(
      renderReviewCall(
        { command: "pr", action: "get", url: "https://github.com/o/r/pull/1" },
        theme,
      ),
    ),
  ).toContain("pr get https://github.com/o/r/pull/1");
});
