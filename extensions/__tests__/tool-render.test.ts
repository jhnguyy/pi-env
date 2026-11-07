import "./tui-setup";
import { componentText, expansionHints } from "./rendering";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  WidthBoundedText,
  renderTextToolResult,
  shortDescription,
  toolExpandHint,
} from "../_shared/tool-render";

describe("shared compact tool rendering", () => {
  it("adds a marker only when text exceeds an explicit limit", () => {
    expect(shortDescription("abcde", { limit: 5 })).toBe("abcde");
    expect(shortDescription("abcdef", { limit: 5 })).toBe("abcde...");
  });

  it("normalizes multiline prose only when requested", () => {
    const source = "first line\n  second\tline";
    expect(shortDescription(source, { oneLine: true })).toBe("first line second line");
    expect(shortDescription(source)).toBe(source);
  });

  it("removes terminal sequences before it truncates a short description", () => {
    const styled = `\u001b[31m${"x".repeat(71)}\u001b[0m`;
    expect(shortDescription(styled, { limit: 70 })).toBe(`${"x".repeat(70)}...`);
  });

  it("preserves separate lines within the viewport", () => {
    const lines = new WidthBoundedText("first\nsecond line exceeds viewport").render(12);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("first");
    expect(lines[1]).toContain("second");
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(12);
  });

  it("uses the Pi error context and reveals complete content on expansion", () => {
    const theme = {
      fg: (style: string, text: string) => `<${style}>${text}</${style}>`,
      bold: (text: string) => text,
    };
    const output = `denied: ${"details ".repeat(20)}`;
    const context = { isError: true, ...expansionHints };
    const result = { content: [{ type: "text" as const, text: output }], details: undefined };
    const collapsed = componentText(
      renderTextToolResult("sample", result, { expanded: false, isPartial: false }, theme, context),
    );
    expect(collapsed).toContain("<error>✗</error>");
    expect(collapsed).toContain("denied");
    expect(collapsed).not.toContain(output);
    const expanded = componentText(
      renderTextToolResult("sample", result, { expanded: true, isPartial: false }, theme, context),
    );
    expect(expanded).toContain(output);
    expect(expanded).not.toContain("host hint");
  });

  it("decorates enabled host hints and omits disabled hints without formatting them", () => {
    const theme = { fg: (_style: string, text: string) => text };
    expect(toolExpandHint(theme, expansionHints)).toBe("(host hint)");
    expect(
      toolExpandHint(theme, {
        keyText: () => "",
        keyHint: () => {
          throw new Error("Disabled hints must not be formatted");
        },
      }),
    ).toBe("");
  });
});
