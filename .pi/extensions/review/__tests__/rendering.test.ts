import "../../__tests__/tui-setup";
import { expect, it } from "vitest";
import { componentText as textOf, expansionHints } from "../../__tests__/rendering";
import { renderReviewCall, renderReviewResult } from "../render";

const theme = { fg: (style: string, text: string) => `<${style}>${text}</${style}>` };
const result = {
  content: [{ type: "text" as const, text: `Pull request context\n${"body ".repeat(30)}end` }],
  details: { status: "ok" },
};
it("renders get calls compactly and preserves full context only in expanded results", () => {
  expect(
    textOf(
      renderReviewCall(
        { command: "pr", action: "get", url: "https://github.com/o/r/pull/1" },
        theme,
      ),
    ),
  ).toContain("pr get https://github.com/o/r/pull/1");
  const context = { isError: false, ...expansionHints };
  const collapsed = textOf(
    renderReviewResult(result, { expanded: false, isPartial: false }, theme, context),
  );
  expect(collapsed).toContain("Pull request context");
  expect(collapsed).not.toContain("end");
  const expanded = textOf(
    renderReviewResult(result, { expanded: true, isPartial: false }, theme, context),
  );
  for (const line of result.content[0].text.split("\n")) expect(expanded).toContain(line);
});
it("uses the host error flag and injected expansion binding", () => {
  const context = { isError: true, keyText: () => "alt+x", keyHint: () => "alt+x to expand" };
  const output = textOf(
    renderReviewResult(result, { expanded: false, isPartial: false }, theme, context),
  );
  expect(output).toContain("<error>✗</error>");
  expect(output).toContain("alt+x to expand");
  expect(
    textOf(
      renderReviewResult(result, { expanded: false, isPartial: false }, theme, {
        ...context,
        keyText: () => "",
      }),
    ),
  ).not.toContain("to expand");
});
