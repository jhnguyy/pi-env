import {
  fauxAssistantMessage,
  fauxProvider,
  type Api,
  type Context,
  type Model,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import {
  ModelRegistry,
  ModelRuntime,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as TempDir from "../../../src/testing/temp-dir";
import { toolResultText } from "../../_shared/tool-render";
import { searchPayload } from "../providers";
import { registerWebSearch } from "../search";

async function fixture() {
  const cwd = TempDir.forTestSync("web-search-");
  vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "agent"));
  const model: Model<Api> = {
    ...fauxProvider().provider.getModels()[0],
    provider: "openai",
    api: "openai-responses",
  };
  const tool = registerWebSearch({ registerTool() {} });
  const response = fauxAssistantMessage("The release is available.");
  const runtime = await ModelRuntime.create({
    authPath: join(cwd, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const modelRegistry = new ModelRegistry(runtime);
  const complete = vi
    .spyOn(modelRegistry, "complete")
    .mockImplementation(
      async (_model: Model<Api>, _context: Context, _options?: StreamOptions) => response,
    );
  const ctx = { cwd, model, modelRegistry } as ExtensionToolContext;
  const execute = (signal?: AbortSignal) =>
    tool.execute("search-1", { query: "latest release" }, signal, undefined, ctx);
  return { model, ctx, response, complete, execute };
}

afterEach(() => vi.unstubAllEnvs());

it("rejects unsupported providers before making a request", async () => {
  const f = await fixture();
  f.ctx.model = { ...f.model, provider: "other", api: "other" };
  await expect(f.execute()).rejects.toThrow(/not supported/);
  expect(f.complete).not.toHaveBeenCalled();
});

it.each([
  ["openai-responses", "PI_OPENAI_WEB_TOOLS"],
  ["anthropic-messages", "PI_ANTHROPIC_WEB_TOOLS"],
])("honors the %s search opt-out", async (api, variable) => {
  const f = await fixture();
  vi.stubEnv(variable, "false");
  expect(() => searchPayload({ ...f.model, api }, f.ctx.cwd)).toThrow(/disabled/);
});

it("does not pass off an unsearched model answer as search results", async () => {
  const f = await fixture();
  const result = await f.execute();
  expect(result).toMatchObject({ isError: true, usage: f.response.usage });
  expect(toolResultText(result)).toContain("did not complete a web search");
  expect(toolResultText(result)).not.toContain("The release is available.");
});

it.each([
  { stopReason: "error", errorMessage: "Search unavailable" },
  { stopReason: "length" },
  { stopReason: "stop", rawStopReason: "pause_turn" },
] as const)(
  "reports incomplete provider responses ($stopReason, $rawStopReason)",
  async (response) => {
    const f = await fixture();
    Object.assign(f.response, response);
    expect(await f.execute()).toMatchObject({ isError: true, usage: f.response.usage });
  },
);

it("reports hosted search errors rather than an empty search", async () => {
  const f = await fixture();
  const model = { ...f.model, provider: "anthropic", api: "anthropic-messages" };
  f.ctx.model = model;
  f.complete.mockImplementationOnce(async (_model, _context, options) => {
    await options?.onProviderStreamEvent?.(
      {
        type: "content_block_start",
        content_block: {
          type: "web_search_tool_result",
          content: { type: "web_search_tool_result_error", error_code: "rate_limit_exceeded" },
        },
      },
      model,
    );
    return f.response;
  });
  const result = await f.execute();
  expect(result.isError).toBe(true);
  expect(toolResultText(result)).toContain("rate_limit_exceeded");
});

it("does not start cancelled searches and forwards in-flight cancellation", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(f.execute(controller.signal)).rejects.toThrow();
  expect(f.complete).not.toHaveBeenCalled();
  const running = new AbortController();
  f.complete.mockImplementationOnce(async (_model, _context, options) => {
    running.abort();
    expect(options?.signal?.aborted).toBe(true);
    return f.response;
  });
  await expect(f.execute(running.signal)).rejects.toThrow();
});

it("bounds output without losing sources", async () => {
  const f = await fixture();
  f.response.content = [{ type: "text", text: "answer\n".repeat(10_000) }];
  f.complete.mockImplementationOnce(async (_model, _context, options) => {
    await options?.onProviderStreamEvent?.(
      {
        type: "response.output_item.done",
        item: {
          type: "web_search_call",
          status: "completed",
          action: { sources: [{ url: "https://example.com/release" }] },
        },
      },
      f.model,
    );
    return f.response;
  });
  const result = await f.execute();
  const text = toolResultText(result);
  expect(Buffer.byteLength(text)).toBeLessThan(50_000);
  expect(text).toContain("truncated");
  expect(text).toContain("https://example.com/release");
});
