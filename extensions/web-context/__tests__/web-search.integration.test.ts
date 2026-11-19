import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  ModelRegistry,
  ModelRuntime,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import * as TempDir from "../../../src/testing/temp-dir";
import { registerWebSearch } from "../search";
import { toolResultText } from "../../_shared/tool-render";

afterEach(() => vi.unstubAllEnvs());

it.each(["openai-responses", "anthropic-messages"] as const)(
  "uses native %s transport/auth and preserves source metadata omitted from normalized messages",
  async (api) => {
    const root = TempDir.forTestSync("native-web-search-");
    vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
    const modelId = "gpt-5.5";
    mkdirSync(join(root, ".pi"));
    writeFileSync(
      join(root, ".pi", "settings.json"),
      JSON.stringify({
        webContext: {
          openaiHostedTools: {
            enabled: false,
            searchContextSize: "high",
            externalWebAccess: false,
          },
          anthropicHostedTools: { enabled: false, tools: ["web_search", "web_fetch"], maxUses: 3 },
        },
      }),
    );
    vi.stubEnv(
      api === "openai-responses" ? "PI_OPENAI_WEB_TOOLS" : "PI_ANTHROPIC_WEB_TOOLS",
      "true",
    );
    const source = {
      type: "web_search_result",
      title: "Release notes",
      url: "https://example.com/release",
      encrypted_content: "must-not-be-returned",
    };
    const claim = "Release 42 is available.";
    const continuation = " Support ends tomorrow.";
    const consulted = Array.from({ length: 35 }, (_, index) => ({
      type: "web_search_result",
      title: `Consulted ${index}`,
      url: `https://example.com/consulted/${index}`,
    }));
    const outputText = {
      type: "output_text",
      text: claim + continuation,
      annotations: [
        {
          type: "url_citation",
          title: source.title,
          url: source.url,
          start_index: 0,
          end_index: claim.length,
        },
      ],
    };
    const message = {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [outputText],
    };
    const search = {
      type: "web_search_call",
      id: "ws_1",
      status: "completed",
      action: { type: "search", query: "latest release", sources: consulted },
    };
    const events =
      api === "openai-responses"
        ? [
            { type: "response.output_item.done", output_index: 0, item: search },
            {
              type: "response.output_item.added",
              output_index: 1,
              item: { ...message, content: [] },
            },
            { type: "response.output_item.done", output_index: 1, item: message },
            {
              type: "response.completed",
              response: {
                id: "resp_1",
                model: modelId,
                status: "completed",
                output: [search, message],
                usage: { input_tokens: 20, output_tokens: 30, total_tokens: 50 },
              },
            },
          ]
        : [
            {
              type: "message_start",
              message: {
                id: "msg_1",
                type: "message",
                role: "assistant",
                model: modelId,
                content: [],
                usage: { input_tokens: 20, output_tokens: 0 },
              },
            },
            {
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "server_tool_use",
                id: "srv_1",
                name: "web_search",
                input: { query: "latest release" },
              },
            },
            { type: "content_block_stop", index: 0 },
            {
              type: "content_block_start",
              index: 1,
              content_block: {
                type: "web_search_tool_result",
                tool_use_id: "srv_1",
                content: [...consulted, source],
              },
            },
            { type: "content_block_stop", index: 1 },
            {
              type: "content_block_start",
              index: 2,
              content_block: { type: "text", text: claim },
            },
            {
              type: "content_block_delta",
              index: 2,
              delta: {
                type: "citations_delta",
                citation: {
                  type: "web_search_result_location",
                  url: source.url,
                  title: source.title,
                  cited_text: "Release 42",
                  encrypted_index: "must-not-be-returned",
                },
              },
            },
            {
              type: "content_block_delta",
              index: 2,
              delta: { type: "text_delta", text: continuation },
            },
            { type: "content_block_stop", index: 2 },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 30 },
            },
            { type: "message_stop" },
          ];
    let receivedPath = "";
    let authenticated = false;
    let request: Record<string, unknown> | undefined;
    async function respond(req: IncomingMessage, res: ServerResponse) {
      receivedPath = req.url ?? "";
      authenticated =
        api === "openai-responses"
          ? req.headers.authorization === "Bearer fixture-key"
          : req.headers["x-api-key"] === "fixture-key";
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      request = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      );
    }
    await using server = createServer((req, res) => {
      void respond(req, res).catch((error: Error) => res.destroy(error));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    const runtime = await ModelRuntime.create({
      authPath: join(root, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerProvider("search-fixture", {
      baseUrl: `http://127.0.0.1:${address.port}${api === "openai-responses" ? "/v1" : ""}`,
      apiKey: "fixture-key",
      api,
      models: [
        {
          id: modelId,
          name: "Search fixture",
          reasoning: false,
          input: ["text"],
          contextWindow: 100_000,
          maxTokens: 16384,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
    const registry = new ModelRegistry(runtime);
    const model = registry.find("search-fixture", modelId);
    if (!model) throw new Error("Missing fixture model");
    const tool = registerWebSearch({ registerTool() {} });
    const current = { ...model, provider: "other", api: "other" };
    const ctx = { cwd: root, model: current, modelRegistry: registry } as ExtensionToolContext;
    const result = await tool.execute(
      "search-1",
      { query: "latest release", model: "search-fixture/gpt-5.5" },
      undefined,
      undefined,
      ctx,
    );
    expect(result.isError).not.toBe(true);
    expect(toolResultText(result)).toContain(`${claim} [source](<${source.url}>)${continuation}`);
    expect(result.details).toHaveProperty("sources.0.url", source.url);
    expect(result.details).toHaveProperty("truncated", true);
    expect(api === "openai-responses" ? request?.max_output_tokens : request?.max_tokens).toBe(
      api === "openai-responses" ? undefined : 16384,
    );
    expect(JSON.stringify(result)).not.toContain(source.encrypted_content);
    expect(result.usage).toMatchObject({ input: 20, output: 30, totalTokens: 50 });
    expect(authenticated).toBe(true);
    expect(new URL(receivedPath, "http://fixture").pathname).toBe(
      api === "openai-responses" ? "/v1/responses" : "/v1/messages",
    );
    expect(request?.tools).toEqual([
      api === "openai-responses"
        ? { type: "web_search", search_context_size: "high", external_web_access: false }
        : { type: "web_search_20250305", name: "web_search", max_uses: 3 },
    ]);
    expect(ctx.model).toBe(current);
    const messages = api === "openai-responses" ? request?.input : request?.messages;
    expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "user" })]));
    if (!Array.isArray(messages)) throw new Error("Missing query messages");
    expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(JSON.stringify(request)).toContain("latest release");
  },
);
