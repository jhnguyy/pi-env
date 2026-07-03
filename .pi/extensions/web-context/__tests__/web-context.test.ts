import { describe, expect, it } from "vitest";
import { buildContextPlan, parseWebUrl, selectAdapter } from "../index";
import { AnthropicHostedToolName, injectAnthropicHostedWebTools, shouldInjectAnthropicHostedWebTools, type AnthropicWebToolSettings } from "../anthropic-tools";

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

describe("anthropic hosted web tools", () => {
  const settings: AnthropicWebToolSettings = { enabled: true, tools: [AnthropicHostedToolName.WebSearch, AnthropicHostedToolName.WebFetch], maxUses: 3 };

  it("injects hosted search/fetch tools without replacing existing tools", () => {
    const payload = injectAnthropicHostedWebTools({ tools: [{ name: "read", input_schema: { type: "object" } }] }, settings) as { tools: Array<Record<string, unknown>> };

    expect(payload.tools).toEqual([
      { name: "read", input_schema: { type: "object" } },
      { type: "web_search_20250305", name: "web_search", max_uses: 3 },
      { type: "web_fetch_20250910", name: "web_fetch" },
    ]);
  });

  it("does not duplicate hosted tools", () => {
    const payload = injectAnthropicHostedWebTools({ tools: [{ type: "web_search_20250305", name: "web_search" }] }, settings) as { tools: Array<Record<string, unknown>> };

    expect(payload.tools).toEqual([
      { type: "web_search_20250305", name: "web_search" },
      { type: "web_fetch_20250910", name: "web_fetch" },
    ]);
  });

  it("only enables hosted tools for direct Anthropic models", () => {
    expect(shouldInjectAnthropicHostedWebTools({ provider: "anthropic", api: "anthropic-messages" }, settings)).toBe(true);
    expect(shouldInjectAnthropicHostedWebTools({ provider: "github-copilot", api: "anthropic-messages" }, settings)).toBe(false);
    expect(shouldInjectAnthropicHostedWebTools({ provider: "anthropic", api: "anthropic-messages" }, { ...settings, enabled: false })).toBe(false);
  });
});
