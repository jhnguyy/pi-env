import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import { WebFetchFailureKind, WebFetchMode, buildContextPlan, fetchWebText, fetchWebTextEffect, parseWebUrl, selectAdapter, type WebFetch } from "../index";
import { AnthropicHostedToolName, injectAnthropicHostedWebTools, loadAnthropicWebToolSettings, shouldInjectAnthropicHostedWebTools, type AnthropicWebToolSettings } from "../anthropic-tools";
import { OpenAISearchContextSize, injectOpenAIHostedWebTools, loadOpenAIWebToolSettings, shouldInjectOpenAIHostedWebTools, type OpenAIWebToolSettings } from "../openai-tools";

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
    const injectedFetch: WebFetch = async () =>
      new Response("<html><head><style>.x{}</style><script>noise()</script><title>T</title></head><body><nav>skip</nav><main><h1>Hello</h1><p>Useful <b>text</b>.</p></main></body></html>", {
        headers: { "content-type": "text/html" },
      });

    const result = await Effect.runPromise(fetchWebTextEffect("https://example.com", { mode: WebFetchMode.Text }, { fetch: injectedFetch }));
    expect(result.text).toContain("Hello");
    expect(result.text).toContain("Useful text.");
    expect(result.text).not.toContain("noise");
    expect(result.text).not.toContain("skip");
  });

  it("preserves HTTP status responses without failing", async () => {
    const injectedFetch: WebFetch = async () => new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });

    const result = await Effect.runPromise(fetchWebTextEffect("https://example.com/missing", {}, { fetch: injectedFetch }));
    expect(result.status).toBe(404);
    expect(result.text).toBe("missing");
  });

  it("returns typed URL failures through the Effect seam", async () => {
    const result = await Effect.runPromise(Effect.either(fetchWebTextEffect("file:///tmp/example.html")));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("WebFetchFailure");
      expect(result.left.kind).toBe(WebFetchFailureKind.Url);
      expect(result.left.message).toContain("Invalid web URL: Unsupported URL protocol: file:");
    }
  });

  it("returns typed request failures through the Effect seam", async () => {
    const injectedFetch: WebFetch = async () => {
      throw new TypeError("socket closed");
    };

    const result = await Effect.runPromise(Effect.either(fetchWebTextEffect("https://example.com", {}, { fetch: injectedFetch })));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.kind).toBe(WebFetchFailureKind.Request);
      expect(result.left.message).toBe("Web fetch request failed: socket closed");
    }
  });

  it("returns typed body failures through the Promise seam", async () => {
    const response = new Response(null);
    response.arrayBuffer = async () => {
      throw new Error("body stream reset");
    };
    const injectedFetch: WebFetch = async () => response;

    await expect(fetchWebText("https://example.com", {}, undefined, { fetch: injectedFetch })).rejects.toMatchObject({
      _tag: "WebFetchFailure",
      kind: WebFetchFailureKind.Body,
      message: "Web fetch body read failed: body stream reset",
      cause: expect.any(Error),
    });
  });

  it("passes caller cancellation to the Promise adapter as a typed failure", async () => {
    const controller = new AbortController();
    let listenerReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      listenerReady = resolve;
    });
    const injectedFetch: WebFetch = (_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        listenerReady();
      });
    };
    const promise = fetchWebText("https://example.com", {}, controller.signal, { fetch: injectedFetch });

    await ready;
    controller.abort(new Error("caller aborted"));
    await expect(promise).rejects.toMatchObject({
      _tag: "WebFetchFailure",
      kind: WebFetchFailureKind.Request,
      message: "Web fetch request failed: caller aborted",
    });
  });

  it("cancels a response body stream on Promise caller abort after headers", async () => {
    const controller = new AbortController();
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    let bodyCancelled!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      bodyCancelled = resolve;
    });
    let rejectRead: ((reason?: unknown) => void) | undefined;
    const response = {
      headers: new Headers(),
      status: 200,
      url: "https://example.com/",
      body: {
        getReader: () => {
          bodyStarted();
          return {
            read: () => new Promise<ReadableStreamReadResult<Uint8Array>>((_resolve, reject) => {
              rejectRead = reject;
            }),
            cancel: (reason?: unknown) => {
              bodyCancelled();
              rejectRead?.(reason);
              return Promise.resolve();
            },
            releaseLock: () => undefined,
          };
        },
      },
    } as unknown as Response;
    const injectedFetch: WebFetch = async () => response;
    const promise = fetchWebText("https://example.com", {}, controller.signal, { fetch: injectedFetch });
    promise.catch(() => undefined);

    await started;
    controller.abort(new Error("caller aborted body"));
    await expect(cancelled).resolves.toBeUndefined();
    await expect(promise).rejects.toMatchObject({ kind: WebFetchFailureKind.Body, message: "Web fetch body read failed: caller aborted body" });
  });

  it("cancels a response body stream on direct Effect interruption after headers", async () => {
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    let bodyCancelled!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      bodyCancelled = resolve;
    });
    let rejectRead: ((reason?: unknown) => void) | undefined;
    const response = {
      headers: new Headers(),
      status: 200,
      url: "https://example.com/",
      body: {
        getReader: () => {
          bodyStarted();
          return {
            read: () => new Promise<ReadableStreamReadResult<Uint8Array>>((_resolve, reject) => {
              rejectRead = reject;
            }),
            cancel: (reason?: unknown) => {
              bodyCancelled();
              rejectRead?.(reason);
              return Promise.resolve();
            },
            releaseLock: () => undefined,
          };
        },
      },
    } as unknown as Response;
    const injectedFetch: WebFetch = async () => response;
    const fiber = Effect.runFork(fetchWebTextEffect("https://example.com", {}, { fetch: injectedFetch }));

    await started;
    await Effect.runPromise(Fiber.interrupt(fiber));
    await expect(cancelled).resolves.toBeUndefined();
  });
});

describe("openai hosted web tools", () => {
  const settings: OpenAIWebToolSettings = { enabled: true, searchContextSize: OpenAISearchContextSize.Low, externalWebAccess: false };

  it("loads typed settings with defaults and env enabled precedence", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-context-test-"));
    mkdirSync(join(dir, ".pi"));
    writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ webContext: { openaiHostedTools: { enabled: false, searchContextSize: "high", externalWebAccess: true } } }));

    expect(loadOpenAIWebToolSettings(dir, { PI_OPENAI_WEB_TOOLS: "true" })).toEqual({ enabled: true, searchContextSize: "high", externalWebAccess: true });
    expect(loadOpenAIWebToolSettings(mkdtempSync(join(tmpdir(), "web-context-test-")), {})).toEqual({ enabled: true, searchContextSize: "low", externalWebAccess: undefined });
  });

  it("rejects malformed persisted OpenAI hosted tool fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-context-test-"));
    mkdirSync(join(dir, ".pi"));
    writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ webContext: { openaiHostedTools: { enabled: "yes" } } }));

    expect(() => loadOpenAIWebToolSettings(dir, { PI_OPENAI_WEB_TOOLS: "true" })).toThrow();
  });

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

  it("loads typed settings with defaults and env enabled precedence", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-context-test-"));
    mkdirSync(join(dir, ".pi"));
    writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ webContext: { anthropicHostedTools: { enabled: false, tools: ["web_search", "web_fetch", "web_search"], maxUses: 5 } } }));

    expect(loadAnthropicWebToolSettings(dir, { PI_ANTHROPIC_WEB_TOOLS: "true" })).toEqual({ enabled: true, tools: ["web_search", "web_fetch"], maxUses: 5 });
    expect(loadAnthropicWebToolSettings(mkdtempSync(join(tmpdir(), "web-context-test-")), {})).toEqual({ enabled: true, tools: ["web_search"], maxUses: undefined });
  });

  it("rejects malformed persisted Anthropic hosted tool fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-context-test-"));
    mkdirSync(join(dir, ".pi"));
    writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ webContext: { anthropicHostedTools: { tools: ["bad"] } } }));

    expect(() => loadAnthropicWebToolSettings(dir, {})).toThrow();
  });

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
