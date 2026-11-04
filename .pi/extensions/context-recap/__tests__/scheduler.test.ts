import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import contextRecap from "../index";
import { requestLifetime } from "../lifetime";

let root: string;
let agentDir: string;
let cwd: string;

function fixture() {
  const pi = { on: vi.fn(), registerCommand: vi.fn() };
  const sessionManager = SessionManager.inMemory(cwd);
  const model: NonNullable<ExtensionContext["model"]> = fauxProvider().getModel();
  const ctx = {
    mode: "tui",
    cwd,
    model,
    thinkingLevel: "off",
    sessionManager,
    isIdle: vi.fn(() => true),
    hasPendingMessages: vi.fn(() => false),
    compact: vi.fn(),
    modelRegistry: { complete: vi.fn() },
    ui: { notify: vi.fn() },
    hasUI: true,
  };
  contextRecap(pi);
  const emit = (name: string, event = {}) =>
    pi.on.mock.calls.find(([n]) => n === name)?.[1](event, ctx);
  const command = (args: string) => pi.registerCommand.mock.calls[0][1].handler(args, ctx);
  const success = async (payload: unknown = {}) => {
    await emit("input");
    await emit("before_agent_start");
    await emit("turn_start");
    await emit("before_provider_request", { payload });
    sessionManager.appendMessage({
      ...fauxAssistantMessage("completed"),
      provider: model.provider,
      model: model.id,
    });
    await emit("agent_settled", { aborted: false });
  };
  return { ctx, emit, command, success };
}

let now = 1_000_000;
let elapsed = 0;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const scheduled = new Map<ReturnType<typeof setTimeout>, { at: number; callback: () => void }>();
async function advance(ms: number) {
  now += ms;
  elapsed += ms;
  for (const [handle, task] of [...scheduled])
    if (task.at <= elapsed) {
      scheduled.delete(handle);
      task.callback();
    }
  await Promise.resolve();
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "context-recap-scheduler-"));
  agentDir = join(root, "agent");
  cwd = join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), "{}");
  writeFileSync(join(cwd, ".pi/settings.json"), "{}");
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  now = 1_000_000;
  elapsed = 0;
  scheduled.clear();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, ms = 0, ...args) => {
    const handle = realSetTimeout(() => {}, 0);
    realClearTimeout(handle);
    vi.spyOn(handle, "unref");
    scheduled.set(handle, { at: elapsed + ms, callback: () => callback(...args) });
    return handle;
  });
  vi.spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
    if (typeof handle === "object" && handle !== null) scheduled.delete(handle);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("one-shot root scheduler and reservation", () => {
  it("defaults off and enabling never arms from restored history", async () => {
    const f = fixture();
    await f.success();
    await f.command("on 5m");
    await advance(300_000);
    expect(f.ctx.compact).not.toHaveBeenCalled();
    await f.success();
    expect(scheduled.size).toBe(1);
    for (const handle of scheduled.keys()) expect(handle.unref).toHaveBeenCalledOnce();
    await advance(270_000);
    expect(f.ctx.compact).toHaveBeenCalledTimes(1);
    f.ctx.compact.mock.calls[0][0].onComplete();
    await advance(900_000);
    expect(f.ctx.compact).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "requires a user estimate without a payload hook (estimate: %s)",
    async (estimated) => {
      const f = fixture();
      await f.command(estimated ? "on 5m" : "on");
      await f.emit("input");
      await f.emit("before_agent_start");
      await f.emit("turn_start");
      f.ctx.sessionManager.appendMessage({
        ...fauxAssistantMessage("completed"),
        provider: f.ctx.model.provider,
        model: f.ctx.model.id,
      });
      await f.emit("agent_settled", { aborted: false });
      expect(scheduled.size).toBe(estimated ? 1 : 0);
      await advance(270_000);
      expect(f.ctx.compact).toHaveBeenCalledTimes(estimated ? 1 : 0);
    },
  );

  it("lets payload caching-off override the turn anchor and user estimate", async () => {
    const f = fixture();
    f.ctx.model.api = "openai-responses";
    f.ctx.model.baseUrl = "https://api.openai.com/v1";
    f.ctx.model.compat = { supportsExplicitPromptCacheMode: true };
    await f.command("on 5m");
    await f.success({ prompt_cache_options: { mode: "explicit" } });
    expect(scheduled.size).toBe(0);
    await advance(300_000);
    expect(f.ctx.compact).not.toHaveBeenCalled();
  });

  it("resets on activity and only a later fresh successful run arms again", async () => {
    const f = fixture();
    await f.command("on 5m");
    await f.success();
    await advance(100_000);
    await f.emit("input");
    await advance(300_000);
    expect(f.ctx.compact).not.toHaveBeenCalled();
    await f.emit("before_agent_start");
    await f.emit("before_provider_request", { payload: {} });
    await f.emit("agent_settled", { aborted: true });
    await advance(300_000);
    expect(f.ctx.compact).not.toHaveBeenCalled();
    await f.success();
    await advance(270_000);
    expect(f.ctx.compact).toHaveBeenCalledTimes(1);
  });

  it.each([
    "late",
    "backward",
    "busy",
    "queued",
    "mode",
    "ui",
    "shutdown",
    "off",
    "model",
    "warming",
  ])("skips %s without retry", async (cause) => {
    const f = fixture();
    await f.command("on 5m");
    await f.success();
    if (cause === "late") now = 2_000_000;
    if (cause === "backward") now = 0;
    if (cause === "busy") f.ctx.isIdle.mockReturnValue(false);
    if (cause === "queued") f.ctx.hasPendingMessages.mockReturnValue(true);
    if (cause === "mode") f.ctx.mode = "rpc";
    if (cause === "ui") await f.emit("ui_prompt_start");
    if (cause === "shutdown") {
      await f.emit("session_shutdown");
      await f.emit("session_shutdown");
    }
    if (cause === "off") await f.command("off");
    if (cause === "model") await f.emit("model_select");
    if (cause === "warming")
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "idle" }));
    await advance(270_000);
    expect(f.ctx.compact).not.toHaveBeenCalled();
    await advance(900_000);
    expect(f.ctx.compact).not.toHaveBeenCalled();
  });

  it.each(["input", "before_agent_start"])(
    "gates %s until native terminal callback, without abort or replay",
    async (event) => {
      const f = fixture();
      await f.command("now");
      let continued = false;
      const pending = f.emit(event).then((result: unknown) => {
        continued = true;
        return result;
      });
      await Promise.resolve();
      expect(continued).toBe(false);
      await f.command("cancel");
      expect(continued).toBe(false);
      f.ctx.compact.mock.calls[0][0].onComplete();
      expect(await pending).toEqual(event === "input" ? { action: "continue" } : undefined);
      expect(f.ctx.compact).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["input", "before_agent_start"])(
    "%s cancels before a delayed hook and during inference without releasing ownership",
    async (gate) => {
      const f = fixture();
      const event = {
        preparation: {
          messagesToSummarize: [],
          turnPrefixMessages: [],
          firstKeptEntryId: "none",
          tokensBefore: 1,
        },
        signal: new AbortController().signal,
      };
      await f.command("now");
      const early = f.emit(gate);
      expect(await f.emit("session_before_compact", event)).toEqual({ cancel: true });
      expect(f.ctx.modelRegistry.complete).not.toHaveBeenCalled();
      await f.command("status");
      expect(f.ctx.ui.notify.mock.lastCall?.[0]).toContain("acquiring; cancellation requested");
      f.ctx.compact.mock.calls[0][0].onError();
      await early;
      if (gate === "before_agent_start") await f.emit("agent_settled", { aborted: true });
      await f.success();
      await f.command("now");
      let resolve!: (value: ReturnType<typeof fauxAssistantMessage>) => void;
      f.ctx.modelRegistry.complete.mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const proposal = f.emit("session_before_compact", event);
      const signal = f.ctx.modelRegistry.complete.mock.calls[0][2].signal;
      await f.command("status");
      expect(f.ctx.ui.notify.mock.lastCall?.[0]).toContain("generating");
      let continued = false;
      const pending = f.emit(gate).then(() => {
        continued = true;
      });
      expect(signal.aborted).toBe(true);
      expect(await proposal).toEqual({ cancel: true });
      resolve(
        fauxAssistantMessage(
          "## Objective\nGoal\n## Plan and Progress\nDone\n## Remaining Work\nNone\n## Information Sources\nREADME.md",
        ),
      );
      await Promise.resolve();
      expect(continued).toBe(false);
      f.ctx.compact.mock.calls[1][0].onError();
      await pending;
      expect(continued).toBe(true);
    },
  );

  it("ignores stale callbacks and shutdown releases waiters", async () => {
    const f = fixture();
    await f.command("now");
    const first = f.ctx.compact.mock.calls[0][0];
    first.onComplete();
    await f.command("now");
    first.onError();
    let continued = false;
    const pending = f.emit("input").then(() => {
      continued = true;
    });
    await Promise.resolve();
    expect(continued).toBe(false);
    await f.emit("session_shutdown");
    await pending;
    expect(continued).toBe(true);
  });

  it.each([
    "missed settlement",
    "wrong physical model",
    "tool calls",
    "error",
    "settings uncertain",
  ])("never arms after %s", async (cause) => {
    const f = fixture();
    await f.command("on 5m");
    await f.emit("input");
    await f.emit("before_agent_start");
    await f.emit("before_provider_request", { payload: {} });
    const response = {
      ...fauxAssistantMessage("completed"),
      provider: f.ctx.model.provider,
      model: f.ctx.model.id,
    };
    if (cause === "wrong physical model") response.model = "other-model";
    if (cause === "error") response.stopReason = "error";
    if (cause === "tool calls")
      response.content.push({ type: "toolCall", id: "pending", name: "read", arguments: {} });
    if (cause === "missed settlement") now += 280_000;
    if (cause === "settings uncertain")
      writeFileSync(join(cwd, ".pi/settings.json"), "{ malformed");
    f.ctx.sessionManager.appendMessage(response);
    await f.emit("agent_settled", { aborted: false });
    await advance(300_000);
    expect(f.ctx.compact).not.toHaveBeenCalled();
  });

  it("recovers from unresolved preflight on a later clean run, even with auto off", async () => {
    const f = fixture();
    await f.emit("input"); // No before_agent_start: consumed or failed before run.
    await f.command("on 5m");
    await f.command("status");
    expect(f.ctx.ui.notify.mock.lastCall?.[0]).toContain("unresolved latest input preflight");
    await f.command("now");
    expect(f.ctx.compact).not.toHaveBeenCalled();
    await f.command("off");
    await f.success();
    await f.command("now");
    expect(f.ctx.compact).toHaveBeenCalledTimes(1);
    f.ctx.compact.mock.calls[0][0].onComplete();
    await f.command("on 5m");
    await f.success();
    await advance(270_000);
    expect(f.ctx.compact).toHaveBeenCalledTimes(2);
  });

  it("reports scheduled target, lifetime and source", async () => {
    const f = fixture();
    await f.command("on 5m");
    await f.success();
    await f.command("status");
    expect(f.ctx.ui.notify.mock.lastCall?.[0]).toContain(
      "scheduled for 1970-01-01T00:21:10.000Z; TTL 300s; source: user estimate",
    );
    await f.command("cancel");
    expect(f.ctx.ui.notify.mock.lastCall?.[0]).toBe("Scheduled context recap cancelled.");
    await f.command("status");
    expect(f.ctx.ui.notify.mock.lastCall?.[0]).not.toContain("scheduled for");
    await f.command("now");
    await f.command("off");
    expect(f.ctx.ui.notify.mock.lastCall?.[0]).toBe(
      "Automatic context recap off. Active context recap cancelled.",
    );
  });

  it("refines the early turn anchor when the payload hook arrives later", async () => {
    const f = fixture();
    await f.command("on 5m");
    await f.emit("input");
    await f.emit("before_agent_start");
    await f.emit("turn_start");
    await advance(10_000);
    await f.emit("before_provider_request", { payload: {} });
    f.ctx.sessionManager.appendMessage({
      ...fauxAssistantMessage("completed"),
      provider: f.ctx.model.provider,
      model: f.ctx.model.id,
    });
    await f.emit("agent_settled", { aborted: false });
    await advance(260_000);
    expect(f.ctx.compact).not.toHaveBeenCalled();
    await advance(10_000);
    expect(f.ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("keeps known lifetimes dynamic rather than applying a user estimate", async () => {
    const f = fixture();
    f.ctx.model.api = "anthropic-messages";
    await f.command("on 5m");
    await f.emit("input");
    await f.emit("before_agent_start");
    await f.emit("before_provider_request", {
      payload: { cache_control: { type: "ephemeral", ttl: "1h" } },
    });
    f.ctx.sessionManager.appendMessage({
      ...fauxAssistantMessage("completed"),
      provider: f.ctx.model.provider,
      model: f.ctx.model.id,
    });
    await f.emit("agent_settled", { aborted: false });
    await advance(270_000);
    expect(f.ctx.compact).not.toHaveBeenCalled();
    await advance(2_970_000);
    expect(f.ctx.compact).toHaveBeenCalledTimes(1);
  });

  it.each(["rpc", "print", "json"])("leaves native %s compaction behavior alone", async (mode) => {
    const f = fixture();
    f.ctx.mode = mode;
    await f.command("on 5m");
    await f.command("now");
    expect(await f.emit("session_before_compact")).toBeUndefined();
    expect(f.ctx.compact).not.toHaveBeenCalled();
  });

  it("discards a model-specific estimate on model change", async () => {
    const f = fixture();
    await f.command("on 5m");
    await f.emit("model_select");
    await f.success();
    await advance(300_000);
    expect(f.ctx.compact).not.toHaveBeenCalled();
    await f.command("status");
    expect(f.ctx.ui.notify.mock.lastCall?.[0]).toContain("unknown");
  });

  it("suppresses settlement when input arrives during a run, then recovers", async () => {
    const f = fixture();
    await f.command("on 5m");
    await f.emit("input");
    await f.emit("before_agent_start");
    await f.emit("before_provider_request", { payload: {} });
    await f.emit("input");
    await f.emit("agent_settled", { aborted: false });
    await advance(300_000);
    expect(f.ctx.compact).not.toHaveBeenCalled();
    await f.emit("before_agent_start");
    await f.emit("agent_settled", { aborted: false });
    await f.success();
    await advance(270_000);
    expect(f.ctx.compact).toHaveBeenCalledTimes(1);
  });
});

describe("request lifetime facts", () => {
  const model = (api: string, extra = {}) =>
    ({
      ...fauxProvider().getModel(),
      api,
      baseUrl: "https://api.openai.com/v1",
      ...extra,
    }) as ExtensionContext["model"];
  it("uses the shortest Anthropic breakpoint and rejects unknown TTL", () => {
    const m = model("anthropic-messages");
    expect(
      requestLifetime(
        {
          system: [
            { cache_control: { type: "ephemeral", ttl: "1h" } },
            { cache_control: { type: "ephemeral" } },
          ],
        },
        m,
      ),
    ).toBe(300_000);
    expect(requestLifetime({ cache_control: { type: "ephemeral", ttl: "1h" } }, m)).toBe(3_600_000);
    expect(requestLifetime({ cache_control: { type: "ephemeral", ttl: "2h" } }, m)).toBeUndefined();
    expect(requestLifetime({}, m)).toBe("off");
  });
  it.each([
    { tools: [{ name: "read", cache_control: { type: "ephemeral" }, input_schema: {} }] },
    {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }],
        },
      ],
    },
  ])("recognizes actual Anthropic tool/content cache envelopes", (payload) => {
    expect(requestLifetime(payload, model("anthropic-messages"))).toBe(300_000);
  });

  it("honors new public OpenAI TTLs and automatic default, but not caching-off", () => {
    const m = model("openai-responses", { compat: { supportsExplicitPromptCacheMode: true } });
    expect(requestLifetime({}, m)).toBe(1_800_000);
    expect(requestLifetime({ prompt_cache_options: { ttl: "30m" } }, m)).toBe(1_800_000);
    expect(requestLifetime({ prompt_cache_options: { ttl: "12h" } }, m)).toBe(43_200_000);
    expect(requestLifetime({ prompt_cache_options: { mode: "explicit" } }, m)).toBe("off");
    expect(requestLifetime({ prompt_cache_options: { ttl: "24h" } }, m)).toBeUndefined();
    expect(
      requestLifetime(
        {
          prompt_cache_options: { mode: "explicit", ttl: "12h" },
          input: [
            {
              content: [
                { type: "input_text", text: "hello", prompt_cache_breakpoint: { ttl: "30m" } },
              ],
            },
          ],
        },
        m,
      ),
    ).toBe(1_800_000);
    expect(
      requestLifetime(
        {
          prompt_cache_options: { mode: "explicit", ttl: "12h" },
          input: [
            { content: [{ type: "input_text", text: "hello", prompt_cache_breakpoint: {} }] },
          ],
        },
        m,
      ),
    ).toBe(43_200_000);
    expect(
      requestLifetime(
        {
          prompt_cache_options: { mode: "implicit", ttl: "12h" },
          input: [
            {
              content: [
                { type: "input_text", text: "hello", prompt_cache_breakpoint: { ttl: "30m" } },
              ],
            },
          ],
        },
        m,
      ),
    ).toBe(1_800_000);
  });
  it("ignores nested user JSON, tool arguments and schema metadata", () => {
    const m = model("anthropic-messages");
    const nested = { cache_control: { type: "ephemeral", ttl: "invalid" } };
    expect(
      requestLifetime(
        {
          cache_control: { type: "ephemeral", ttl: "1h" },
          tools: [{ input_schema: { properties: nested } }],
          messages: [
            {
              content: [
                { type: "tool_use", input: nested },
                { type: "text", text: JSON.stringify(nested) },
              ],
            },
          ],
        },
        m,
      ),
    ).toBe(3_600_000);
    expect(requestLifetime({ tools: [{ input_schema: nested }] }, m)).toBe("off");
    const openAI = model("openai-responses", { compat: { supportsExplicitPromptCacheMode: true } });
    expect(
      requestLifetime(
        {
          prompt_cache_options: { mode: "explicit" },
          tools: [{ parameters: { prompt_cache_breakpoint: { ttl: "12h" } } }],
          input: [
            {
              content: [
                {
                  type: "input_text",
                  text: '{"prompt_cache_breakpoint":{}}',
                  sample: { prompt_cache_breakpoint: {} },
                },
              ],
            },
          ],
        },
        openAI,
      ),
    ).toBe("off");
    expect(
      requestLifetime(
        {
          prompt_cache_options: { mode: "explicit", ttl: "12h" },
          input: [
            {
              content: [
                {
                  type: "input_text",
                  text: "hello",
                  prompt_cache_breakpoint: {},
                  sample: { prompt_cache_breakpoint: { ttl: "unknown" } },
                },
              ],
            },
          ],
          tools: [{ parameters: { properties: { prompt_cache_breakpoint: { ttl: "30m" } } } }],
        },
        openAI,
      ),
    ).toBe(43_200_000);
    expect(requestLifetime({ model: "different-outgoing-model" }, openAI)).toBeUndefined();
  });

  it("does not invent deadlines from legacy 24h, Codex, proxies or ambiguous model tiers", () => {
    for (const m of [
      model("openai-responses"),
      model("openai-codex-responses"),
      model("openai-responses", {
        baseUrl: "https://proxy.example",
        compat: { supportsExplicitPromptCacheMode: true },
      }),
      model("faux", { promptCache: { short: 300, long: 3600 } }),
    ])
      expect(requestLifetime({ prompt_cache_retention: "24h" }, m)).toBeUndefined();
  });
});
