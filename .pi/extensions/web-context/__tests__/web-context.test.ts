import { describe, expect, it } from "vitest";
import { WebFetchMode, buildContextPlan, fetchWebText, parseWebUrl, selectAdapter } from "../index";
import { AnthropicHostedToolName, injectAnthropicHostedWebTools, shouldInjectAnthropicHostedWebTools, type AnthropicWebToolSettings } from "../anthropic-tools";
import { OpenAISearchContextSize, injectOpenAIHostedWebTools, shouldInjectOpenAIHostedWebTools, type OpenAIWebToolSettings } from "../openai-tools";

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

  it("extracts compact text from HTML by default", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("<html><head><style>.x{}</style><script>noise()</script><title>T</title></head><body><nav>skip</nav><main><h1>Hello</h1><p>Useful <b>text</b>.</p></main></body></html>", {
        headers: { "content-type": "text/html" },
      });
    try {
      const result = await fetchWebText("https://example.com", { mode: WebFetchMode.Text });
      expect(result.text).toContain("Hello");
      expect(result.text).toContain("Useful text.");
      expect(result.text).not.toContain("noise");
      expect(result.text).not.toContain("skip");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("openai hosted web tools", () => {
  const settings: OpenAIWebToolSettings = { enabled: true, searchContextSize: OpenAISearchContextSize.Low, externalWebAccess: false };

  it("injects hosted web_search for GPT-5.5 responses payloads", () => {
    const payload = injectOpenAIHostedWebTools({ tools: [{ name: "read", input_schema: { type: "object" } }] }, settings) as { tools: Array<Record<string, unknown>> };

    expect(payload.tools).toEqual([
      { name: "read", input_schema: { type: "object" } },
      { type: "web_search", search_context_size: "low", external_web_access: false },
    ]);
  });

  it("only enables hosted search for OpenAI GPT-5.5 responses models", () => {
    expect(shouldInjectOpenAIHostedWebTools({ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.5" }, settings)).toBe(true);
    expect(shouldInjectOpenAIHostedWebTools({ provider: "openai", api: "openai-responses", id: "gpt-5.5" }, settings)).toBe(true);
    expect(shouldInjectOpenAIHostedWebTools({ provider: "openai", api: "openai-completions", id: "gpt-5.5" }, settings)).toBe(false);
    expect(shouldInjectOpenAIHostedWebTools({ provider: "github-copilot", api: "openai-responses", id: "gpt-5.5" }, settings)).toBe(false);
    expect(shouldInjectOpenAIHostedWebTools({ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.4" }, settings)).toBe(false);
    expect(shouldInjectOpenAIHostedWebTools({ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.5" }, { ...settings, enabled: false })).toBe(false);
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
