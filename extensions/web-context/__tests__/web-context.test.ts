import "../../__tests__/tui-setup";
import { componentText, expansionHints } from "../../__tests__/rendering";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Fiber } from "effect";
import * as TempDir from "../../../src/testing/temp-dir";
import { afterEach, describe, expect, it, vi } from "vitest";
import webContextExtension, {
  WebFetchFailureKind,
  WebFetchMode,
  fetchWebText,
  fetchWebTextEffect,
  parseWebUrl,
  type WebFetch,
} from "../index";
import {
  AnthropicHostedToolName,
  injectAnthropicHostedWebTools,
  loadAnthropicWebToolSettings,
  shouldInjectAnthropicHostedWebTools,
  type AnthropicWebToolSettings,
} from "../anthropic-tools";
import {
  OpenAISearchContextSize,
  injectOpenAIHostedWebTools,
  loadOpenAIWebToolSettings,
  shouldInjectOpenAIHostedWebTools,
  type OpenAIWebToolSettings,
} from "../openai-tools";

function settingsProject(): string {
  const root = TempDir.forTestSync("web-context-test-");
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

const mockTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function registeredWebFetchTool() {
  const registerTool = vi.fn();
  webContextExtension({
    on: vi.fn(),
    registerTool,
    events: { emit: vi.fn(), on: vi.fn() },
  } as never);
  return registerTool.mock.calls.map(([tool]) => tool).find((tool) => tool.name === "web_fetch");
}

function webFetchToolResult() {
  const hiddenTail = "end of fetched output";
  const body = `Fetched body ${"full output ".repeat(200)}${hiddenTail}`;
  return {
    body,
    hiddenTail,
    result: {
      content: [
        {
          type: "text",
          text: `URL: https://example.com/\nStatus: 200\nContent-Type: text/html\nMode: text\nRaw-Bytes: 8192\nOutput-Bytes: 4096\nTruncated: false\n\n${body}`,
        },
      ],
      details: {
        text: body,
        url: "https://example.com/",
        status: 200,
        contentType: "text/html; charset=utf-8",
        truncated: false,
        mode: WebFetchMode.Text,
        rawBytes: 8192,
        outputBytes: 4096,
      },
    },
  };
}

describe("web fetch", () => {
  it("shows the requested URL in the compact call", () => {
    const tool = registeredWebFetchTool();

    const call = componentText(
      tool.renderCall({ url: "https://example.com/docs?q=pi" }, mockTheme),
    );

    expect(call).toContain("web_fetch");
    expect(call).toContain("https://example.com/docs?q=pi");
  });

  it("shows a bounded fetched-output preview until the user expands it", () => {
    const tool = registeredWebFetchTool();
    const { hiddenTail, result } = webFetchToolResult();

    const collapsed = componentText(
      tool.renderResult(result, { expanded: false }, mockTheme, expansionHints),
      120,
    );

    expect(collapsed).toContain("HTTP 200");
    expect(collapsed).toContain("text/html");
    expect(collapsed).toContain("Fetched body");
    expect(collapsed).not.toContain(hiddenTail);
  });

  it("reveals the full fetched output when expanded", () => {
    const tool = registeredWebFetchTool();
    const { body, result } = webFetchToolResult();

    const expanded = componentText(
      tool.renderResult(result, { expanded: true }, mockTheme, expansionHints),
      4096,
    );

    expect(expanded).toContain(body);
    expect(expanded).toContain("URL: https://example.com/");
  });

  it("rejects non-web protocols", () => {
    expect(() => parseWebUrl("file:///tmp/example.html")).toThrow("Unsupported URL protocol");
  });

  it("extracts compact text from HTML by default", async () => {
    const injectedFetch: WebFetch = async () =>
      new Response(
        "<html><head><style>.x{}</style><script>noise()</script><title>T</title></head><body><nav>skip</nav><main><h1>Hello</h1><p>Useful <b>text</b>.</p></main></body></html>",
        {
          headers: { "content-type": "text/html" },
        },
      );

    const result = await Effect.runPromise(
      fetchWebTextEffect(
        "https://example.com",
        { mode: WebFetchMode.Text },
        { fetch: injectedFetch },
      ),
    );
    expect(result.text).toContain("Hello");
    expect(result.text).toContain("Useful text.");
    expect(result.text).not.toContain("noise");
    expect(result.text).not.toContain("skip");
  });

  it("preserves HTTP status responses without failing", async () => {
    const injectedFetch: WebFetch = async () =>
      new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });

    const result = await Effect.runPromise(
      fetchWebTextEffect("https://example.com/missing", {}, { fetch: injectedFetch }),
    );
    expect(result.status).toBe(404);
    expect(result.text).toBe("missing");
  });

  it("returns typed URL failures through the Effect seam", async () => {
    const result = await Effect.runPromise(
      Effect.result(fetchWebTextEffect("file:///tmp/example.html")),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("WebFetchFailure");
      expect(result.failure.kind).toBe(WebFetchFailureKind.Url);
      expect(result.failure.message).toContain("Invalid web URL: Unsupported URL protocol: file:");
    }
  });

  it("returns typed request failures through the Effect seam", async () => {
    const injectedFetch: WebFetch = async () => {
      throw new TypeError("socket closed");
    };

    const result = await Effect.runPromise(
      Effect.result(fetchWebTextEffect("https://example.com", {}, { fetch: injectedFetch })),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.kind).toBe(WebFetchFailureKind.Request);
      expect(result.failure.message).toBe("Web fetch request failed: socket closed");
    }
  });

  it("returns typed body failures through the Promise seam", async () => {
    const response = new Response(null);
    response.arrayBuffer = async () => {
      throw new Error("body stream reset");
    };
    const injectedFetch: WebFetch = async () => response;

    await expect(
      fetchWebText("https://example.com", {}, undefined, { fetch: injectedFetch }),
    ).rejects.toMatchObject({
      _tag: "WebFetchFailure",
      kind: WebFetchFailureKind.Body,
      message: "Web fetch body read failed: body stream reset",
      cause: expect.any(Error),
    });
  });

  it("preserves a stream read failure and releases the reader", async () => {
    const cause = new Error("stream read failed");
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(cause);
      },
    });
    await expect(
      fetchWebText("https://example.com", {}, undefined, {
        fetch: async () => new Response(body),
      }),
    ).rejects.toMatchObject({ kind: WebFetchFailureKind.Body, cause });
    expect(body.locked).toBe(false);
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
    const promise = fetchWebText("https://example.com", {}, controller.signal, {
      fetch: injectedFetch,
    });

    await ready;
    controller.abort(new Error("caller aborted"));
    await expect(promise).rejects.toMatchObject({
      _tag: "WebFetchFailure",
      kind: WebFetchFailureKind.Request,
      message: "Web fetch request failed: caller aborted",
    });
  });

  it.each([
    [new Error("caller aborted body"), "caller aborted body"],
    [false, "false"],
  ])("cancels a response body stream with reason %s after headers", async (reason, message) => {
    const controller = new AbortController();
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    let bodyCancelled!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      bodyCancelled = resolve;
    });
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          bodyStarted();
        },
        async cancel() {
          await Promise.resolve();
          bodyCancelled();
        },
      },
      { highWaterMark: 0 },
    );
    const response = new Response(body);
    const injectedFetch: WebFetch = async () => response;
    const promise = fetchWebText("https://example.com", {}, controller.signal, {
      fetch: injectedFetch,
    });
    promise.catch(() => undefined);

    await started;
    controller.abort(reason);
    await expect(cancelled).resolves.toBeUndefined();
    await expect(promise).rejects.toMatchObject({
      kind: WebFetchFailureKind.Body,
      message: `Web fetch body read failed: ${message}`,
      cause: reason,
    });
    expect(body.locked).toBe(false);
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
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          bodyStarted();
        },
        async cancel() {
          await Promise.resolve();
          bodyCancelled();
        },
      },
      { highWaterMark: 0 },
    );
    const response = new Response(body);
    const injectedFetch: WebFetch = async () => response;
    const fiber = Effect.runFork(
      fetchWebTextEffect("https://example.com", {}, { fetch: injectedFetch }),
    );

    await started;
    await Effect.runPromise(Fiber.interrupt(fiber));
    await expect(cancelled).resolves.toBeUndefined();
    await vi.waitFor(() => expect(body.locked).toBe(false));
  });
});

describe("openai hosted web tools", () => {
  const settings: OpenAIWebToolSettings = {
    enabled: true,
    searchContextSize: OpenAISearchContextSize.Low,
    externalWebAccess: false,
  };

  it("loads typed settings with defaults and env enabled precedence", () => {
    const dir = settingsProject();
    mkdirSync(join(dir, ".pi"));
    writeFileSync(
      join(dir, ".pi", "settings.json"),
      JSON.stringify({
        webContext: {
          openaiHostedTools: { enabled: false, searchContextSize: "high", externalWebAccess: true },
        },
      }),
    );

    expect(loadOpenAIWebToolSettings(dir, { PI_OPENAI_WEB_TOOLS: "true" })).toEqual({
      enabled: true,
      searchContextSize: "high",
      externalWebAccess: true,
    });
    expect(loadOpenAIWebToolSettings(settingsProject(), {})).toEqual({
      enabled: true,
      searchContextSize: "low",
      externalWebAccess: undefined,
    });
  });

  it("rejects malformed persisted OpenAI hosted tool fields", () => {
    const dir = settingsProject();
    mkdirSync(join(dir, ".pi"));
    writeFileSync(
      join(dir, ".pi", "settings.json"),
      JSON.stringify({ webContext: { openaiHostedTools: { enabled: "yes" } } }),
    );

    expect(() => loadOpenAIWebToolSettings(dir, { PI_OPENAI_WEB_TOOLS: "true" })).toThrow();
  });

  it("injects hosted web_search for GPT-5.5 responses payloads", () => {
    const payload = injectOpenAIHostedWebTools(
      { tools: [{ name: "read", input_schema: { type: "object" } }] },
      settings,
    ) as { tools: Array<Record<string, unknown>> };

    expect(payload.tools).toEqual([
      { name: "read", input_schema: { type: "object" } },
      { type: "web_search", search_context_size: "low", external_web_access: false },
    ]);
  });

  it("only enables hosted search for OpenAI GPT-5.5 responses models", () => {
    expect(
      shouldInjectOpenAIHostedWebTools(
        { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.5" },
        settings,
      ),
    ).toBe(true);
    expect(
      shouldInjectOpenAIHostedWebTools(
        { provider: "openai", api: "openai-responses", id: "gpt-5.5" },
        settings,
      ),
    ).toBe(true);
    expect(
      shouldInjectOpenAIHostedWebTools(
        { provider: "openai", api: "openai-completions", id: "gpt-5.5" },
        settings,
      ),
    ).toBe(false);
    expect(
      shouldInjectOpenAIHostedWebTools(
        { provider: "github-copilot", api: "openai-responses", id: "gpt-5.5" },
        settings,
      ),
    ).toBe(false);
    expect(
      shouldInjectOpenAIHostedWebTools(
        { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.4" },
        settings,
      ),
    ).toBe(false);
    expect(
      shouldInjectOpenAIHostedWebTools(
        { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.5" },
        { ...settings, enabled: false },
      ),
    ).toBe(false);
  });
});

describe("anthropic hosted web tools", () => {
  const settings: AnthropicWebToolSettings = {
    enabled: true,
    tools: [AnthropicHostedToolName.WebSearch, AnthropicHostedToolName.WebFetch],
    maxUses: 3,
  };

  it("loads typed settings with defaults and env enabled precedence", () => {
    const dir = settingsProject();
    mkdirSync(join(dir, ".pi"));
    writeFileSync(
      join(dir, ".pi", "settings.json"),
      JSON.stringify({
        webContext: {
          anthropicHostedTools: {
            enabled: false,
            tools: ["web_search", "web_fetch", "web_search"],
            maxUses: 5,
          },
        },
      }),
    );

    expect(loadAnthropicWebToolSettings(dir, { PI_ANTHROPIC_WEB_TOOLS: "true" })).toEqual({
      enabled: true,
      tools: ["web_search", "web_fetch"],
      maxUses: 5,
    });
    expect(loadAnthropicWebToolSettings(settingsProject(), {})).toEqual({
      enabled: true,
      tools: ["web_search"],
      maxUses: undefined,
    });
  });

  it("rejects malformed persisted Anthropic hosted tool fields", () => {
    const dir = settingsProject();
    mkdirSync(join(dir, ".pi"));
    writeFileSync(
      join(dir, ".pi", "settings.json"),
      JSON.stringify({ webContext: { anthropicHostedTools: { tools: ["bad"] } } }),
    );

    expect(() => loadAnthropicWebToolSettings(dir, {})).toThrow();
  });

  it("injects hosted search/fetch tools without replacing existing tools", () => {
    const payload = injectAnthropicHostedWebTools(
      { tools: [{ name: "read", input_schema: { type: "object" } }] },
      settings,
    ) as { tools: Array<Record<string, unknown>> };

    expect(payload.tools).toEqual([
      { name: "read", input_schema: { type: "object" } },
      { type: "web_search_20250305", name: "web_search", max_uses: 3 },
      { type: "web_fetch_20250910", name: "web_fetch" },
    ]);
  });

  it("does not duplicate hosted tools", () => {
    const payload = injectAnthropicHostedWebTools(
      { tools: [{ type: "web_search_20250305", name: "web_search" }] },
      settings,
    ) as { tools: Array<Record<string, unknown>> };

    expect(payload.tools).toEqual([
      { type: "web_search_20250305", name: "web_search" },
      { type: "web_fetch_20250910", name: "web_fetch" },
    ]);
  });

  it("only enables hosted tools for direct Anthropic models", () => {
    expect(
      shouldInjectAnthropicHostedWebTools(
        { provider: "anthropic", api: "anthropic-messages" },
        settings,
      ),
    ).toBe(true);
    expect(
      shouldInjectAnthropicHostedWebTools(
        { provider: "github-copilot", api: "anthropic-messages" },
        settings,
      ),
    ).toBe(false);
    expect(
      shouldInjectAnthropicHostedWebTools(
        { provider: "anthropic", api: "anthropic-messages" },
        { ...settings, enabled: false },
      ),
    ).toBe(false);
  });
});
