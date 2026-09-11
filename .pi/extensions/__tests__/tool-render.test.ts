import "./tui-setup";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHORT_DESCRIPTION_LIMIT,
  WidthBoundedText,
  registerPublicTool,
  renderTextToolResult,
  shortDescription,
} from "../_shared/tool-render";

describe("shared compact tool rendering", () => {
  it("uses the 70-character compatibility limit and adds a marker only on overflow", () => {
    const exact = "x".repeat(DEFAULT_SHORT_DESCRIPTION_LIMIT);
    expect(shortDescription(exact)).toBe(exact);
    expect(shortDescription(`${exact}y`)).toBe(`${exact}...`);
    expect(shortDescription("abcdef", { limit: 5 })).toBe("abcde...");
  });

  it("normalizes multiline prose only when requested", () => {
    const source = "first line\n  second\tline";
    expect(shortDescription(source, { oneLine: true })).toBe("first line second line");
    expect(shortDescription(source)).toBe(source);
  });

  it("removes terminal sequences before it truncates a short description", () => {
    const styled = `\u001b[31m${"x".repeat(71)}\u001b[0m`;
    expect(shortDescription(styled)).toBe(`${"x".repeat(70)}...`);
  });

  it("truncates styled text at the component width without splitting ANSI sequences", () => {
    const styled = `\u001b[31m${"界".repeat(10)}\u001b[0m`;
    const [line] = new WidthBoundedText(styled).render(11);
    expect(visibleWidth(line)).toBeLessThanOrEqual(11);
    expect(stripTerminalSequences(line)).toBe(`${"界".repeat(4)}...`);
    expect(line).toContain("\u001b[0m");
  });

  it("uses the Pi render context for generic error presentation", () => {
    const theme = {
      fg: (style: string, text: string) => `<${style}>${text}</${style}>`,
      bold: (text: string) => text,
    };
    const rendered = renderTextToolResult(
      "sample",
      { content: [{ type: "text", text: "denied" }], details: undefined },
      { expanded: false, isPartial: false },
      theme,
      { isError: true },
    );
    expect((rendered as unknown as { text: string }).text).toContain("<error>✗</error>");
  });

  it("requires both render hooks at the public registration boundary", () => {
    const host = { registerTool: () => undefined };
    // @ts-expect-error Public Pi tools must provide renderCall and renderResult.
    registerPublicTool(host, {
      name: "incomplete",
      label: "Incomplete",
      description: "An intentionally incomplete test tool.",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text" as const, text: "done" }],
        details: undefined,
      }),
    });
  });
});
