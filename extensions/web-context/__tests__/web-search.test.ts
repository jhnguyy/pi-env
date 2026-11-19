import "../../__tests__/tui-setup";
import { componentText, expansionHints } from "../../__tests__/rendering";
import type { Api, AssistantMessage, Context, Model, StreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as TempDir from "../../../src/testing/temp-dir";
import webContext from "../index";

const usage = {
  input: 20,
  output: 30,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 50,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const openai = {
  provider: "openai-codex",
  api: "openai-codex-responses",
  id: "gpt-5.5",
} as Model<"openai-codex-responses">;
const anthropic = {
  provider: "anthropic",
  api: "anthropic-messages",
  id: "claude-sonnet-4-6",
} as Model<"anthropic-messages">;

function fixture(model: Model<Api> = openai) {
  const cwd = TempDir.forTestSync("web-search-");
  vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "agent"));
  const registerTool = vi.fn();
  const on = vi.fn();
  webContext({
    registerTool,
    on,
    events: { emit: vi.fn(), on: vi.fn() },
  } as unknown as ExtensionAPI);
  const tool = registerTool.mock.calls
    .map(([definition]) => definition)
    .find((definition) => definition.name === "web_search");
  const response = {
    role: "assistant",
    provider: model.provider,
    api: model.api,
    model: model.id,
    content: [{ type: "text", text: "The release is available." }],
    usage,
    stopReason: "stop",
    timestamp: 1,
  } as AssistantMessage;
  const complete = vi.fn(async (_model: Model<Api>, _context: Context, options: StreamOptions) => {
    await options.onPayload?.({ tools: [] }, model);
    if (model.api === "anthropic-messages") {
      await options.onProviderStreamEvent?.(
        {
          type: "content_block_start",
          content_block: { type: "server_tool_use", name: "web_search" },
        },
        model,
      );
      await options.onProviderStreamEvent?.(
        {
          type: "content_block_start",
          content_block: {
            type: "web_search_tool_result",
            content: [
              { type: "web_search_result", url: "https://example.com/release", title: "Release" },
            ],
          },
        },
        model,
      );
    } else {
      await options.onProviderStreamEvent?.(
        {
          type: "response.output_item.done",
          item: {
            type: "web_search_call",
            status: "completed",
            action: {
              type: "search",
              sources: [{ type: "url", url: "https://example.com/release", title: "Release" }],
            },
          },
        },
        model,
      );
    }
    return response;
  });
  const ctx = {
    cwd,
    model,
    modelRegistry: { complete, find: vi.fn() },
  } as unknown as ExtensionToolContext;
  const execute = (query = "latest release", signal?: AbortSignal) =>
    tool.execute("search-1", { query }, signal, undefined, ctx);
  return { tool, on, complete, ctx, response, execute };
}

afterEach(() => vi.unstubAllEnvs());

describe("visible web search", () => {
  it.each([openai, anthropic])(
    "returns a separate $provider search with sources and usage",
    async (model) => {
      const f = fixture(model);
      expect(f.tool).toBeDefined();
      const result = await f.execute();
      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toContain("The release is available.");
      expect(result.content[0].text).toContain("https://example.com/release");
      expect(result.usage).toEqual(usage);
      const [, context, options] = f.complete.mock.calls[0];
      expect(
        context.messages.filter((message: { role: string }) => message.role === "user"),
      ).toEqual([{ role: "user", content: "latest release", timestamp: expect.any(Number) }]);
      expect(context.messages).toHaveLength(2);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      const payload = (await options.onPayload?.({ tools: [] }, model)) as {
        tools: { type: string; name?: string }[];
      };
      expect(payload.tools).toEqual([
        expect.objectContaining({
          type: model === anthropic ? "web_search_20250305" : "web_search",
        }),
      ]);
      expect(f.on.mock.calls.some(([event]) => event === "before_provider_request")).toBe(false);
    },
  );

  it("does not pass off an unsearched model answer as search results", async () => {
    const f = fixture();
    f.complete.mockImplementationOnce(async () => f.response);
    const result = await f.execute();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/did not.*search/i);
    expect(result.usage).toEqual(usage);
  });

  it("reports provider search errors instead of treating them as an empty search", async () => {
    const f = fixture(anthropic);
    f.complete.mockImplementationOnce(async (_model, _context, options) => {
      await options.onProviderStreamEvent?.(
        {
          type: "content_block_start",
          content_block: {
            type: "web_search_tool_result",
            content: { type: "web_search_tool_result_error", error_code: "rate_limit_exceeded" },
          },
        },
        anthropic,
      );
      return f.response;
    });
    const result = await f.execute();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("rate_limit_exceeded");
  });

  it("returns failed and incomplete provider responses as tool errors", async () => {
    const f = fixture();
    f.response.stopReason = "error";
    f.response.errorMessage = "Search unavailable";
    expect(await f.execute()).toMatchObject({ isError: true, usage });
    f.response.stopReason = "length";
    expect(await f.execute()).toMatchObject({ isError: true });
  });

  it("does not start cancelled searches and forwards cancellation to in-flight requests", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(f.execute("latest release", controller.signal)).rejects.toThrow();
    expect(f.complete).not.toHaveBeenCalled();
    const running = new AbortController();
    f.complete.mockImplementationOnce(async (_model, _context, options) => {
      running.abort();
      expect(options.signal?.aborted).toBe(true);
      return f.response;
    });
    await expect(f.execute("latest release", running.signal)).rejects.toThrow();
  });

  it("rejects unsupported models before making a request", async () => {
    const f = fixture({
      provider: "github-copilot",
      api: "openai-responses",
      id: "gpt-5.5",
    } as Model<Api>);
    await expect(f.execute()).rejects.toThrow(/support/i);
    expect(f.complete).not.toHaveBeenCalled();
  });

  it.each([
    [openai, "PI_OPENAI_WEB_TOOLS"],
    [anthropic, "PI_ANTHROPIC_WEB_TOOLS"],
  ] as const)("honors the $0.provider search opt-out", async (model, variable) => {
    const f = fixture(model);
    vi.stubEnv(variable, "false");
    await expect(f.execute()).rejects.toThrow(/disabled/);
    expect(f.complete).not.toHaveBeenCalled();
  });

  it("uses an explicitly selected search model without changing the active model", async () => {
    const f = fixture();
    const current = { ...openai, provider: "github-copilot" };
    f.ctx.model = current;
    vi.mocked(f.ctx.modelRegistry.find).mockReturnValue(openai);
    const result = await f.tool.execute(
      "search-1",
      { query: "latest release", model: "openai-codex/gpt-5.5" },
      undefined,
      undefined,
      f.ctx,
    );
    expect(result.isError).not.toBe(true);
    expect(f.complete.mock.calls[0][0]).toBe(openai);
    expect(f.ctx.model).toBe(current);
  });

  it("marks Anthropic paused turns as incomplete rather than silently ending the search", async () => {
    const f = fixture(anthropic);
    f.response.rawStopReason = "pause_turn";
    expect(await f.execute()).toMatchObject({ isError: true, usage });
  });

  it("bounds the answer and renders the query and expandable sources", async () => {
    const f = fixture();
    f.response.content = [{ type: "text", text: "x".repeat(70_000) }];
    const result = await f.execute();
    expect(result.content[0].text.length).toBeLessThan(55_000);
    expect(result.content[0].text).toContain("truncated");
    expect(result.content[0].text).toContain("https://example.com/release");
    const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
    expect(componentText(f.tool.renderCall({ query: "latest release" }, theme))).toContain(
      "latest release",
    );
    const collapsed = componentText(
      f.tool.renderResult(result, { expanded: false }, theme, expansionHints),
      120,
    );
    expect(collapsed.length).toBeLessThan(2000);
    expect(
      componentText(f.tool.renderResult(result, { expanded: true }, theme, expansionHints)),
    ).toContain("https://example.com/release");
  });
});
