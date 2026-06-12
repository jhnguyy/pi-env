import { describe, expect, it } from "vitest";
import { buildContextPlan, parseWebUrl, selectAdapter } from "../index";

describe("web context", () => {
  it("selects the GitHub adapter", () => {
    const adapter = selectAdapter(new URL("https://github.com/example/project/issues/1"));
    expect(adapter?.id).toBe("github");
  });

  it("builds a site-specific GitHub plan", () => {
    const plan = buildContextPlan("https://github.com/example/project/pull/1", "review PR context");
    expect(plan).toContain("Adapter: github (GitHub repository/content)");
    expect(plan).toContain("Purpose: review PR context");
    expect(plan).toContain("gh issue/pr view --json");
  });

  it("falls back to a generic browser-last plan", () => {
    const plan = buildContextPlan("https://example.com/page");
    expect(plan).toContain("Adapter: generic");
    expect(plan).toContain("Prefer official APIs");
    expect(plan).toContain("Use the browser only when the user explicitly asks");
  });

  it("rejects non-web protocols", () => {
    expect(() => parseWebUrl("file:///tmp/example.html")).toThrow("Unsupported URL protocol");
  });
});
