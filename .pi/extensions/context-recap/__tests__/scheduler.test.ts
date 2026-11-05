import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import contextRecap from "../index";

let root: string;
let agentDir: string;
let cwd: string;
function settings(value: unknown) {
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(value));
}
function fixture(automatic = true) {
  const pi = { on: vi.fn(), registerCommand: vi.fn() };
  const sessionManager = SessionManager.inMemory(cwd);
  const model: NonNullable<ExtensionContext["model"]> = fauxProvider().getModel();
  const configure = (estimatedLifetime = "5m") =>
    settings({
      contextRecap: { providers: { [model.provider]: { enabled: true, estimatedLifetime } } },
    });
  if (automatic) configure();
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
  const command = (args = "") => pi.registerCommand.mock.calls[0][1].handler(args, ctx);
  const response = () =>
    sessionManager.appendMessage({
      ...fauxAssistantMessage("completed"),
      provider: ctx.model.provider,
      model: ctx.model.id,
    });
  const start = async () => {
    await emit("input");
    await emit("before_agent_start");
    await emit("turn_start");
  };
  const success = async (payload?: unknown) => {
    await start();
    if (payload !== undefined) await emit("before_provider_request", { payload });
    response();
    await emit("agent_settled", { aborted: false });
  };
  return { ctx, emit, command, configure, start, response, success };
}
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "recap-scheduler-"));
  agentDir = join(root, "agent");
  cwd = join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  // Installed fake-timers cannot clone Node's non-configurable Temporal.Now.
  vi.stubGlobal("Temporal", undefined);
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

it("enables known Codex by default, never arms from history, and never rearms itself", async () => {
  const f = fixture(false);
  Object.assign(f.ctx.model, {
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
  });
  f.response();
  await f.emit("session_start");
  await f.command();
  expect(f.ctx.ui.notify.mock.lastCall?.[0]).toContain("Automatic context recap enabled");
  await advance(300_000);
  expect(f.ctx.compact).not.toHaveBeenCalled();
  await f.success();
  await f.command();
  expect(f.ctx.ui.notify.mock.lastCall?.[0]).toContain(
    "built-in default estimate (not a cache guarantee)",
  );
  await advance(270_000);
  expect(f.ctx.compact).toHaveBeenCalledTimes(1);
  f.ctx.compact.mock.calls[0][0].onComplete();
  await advance(900_000);
  expect(f.ctx.compact).toHaveBeenCalledTimes(1);
});

it.each(["default", "enabled", "estimated"])("unknown provider scheduling: %s", async (policy) => {
  const f = fixture(false);
  if (policy === "enabled")
    settings({ contextRecap: { providers: { [f.ctx.model.provider]: { enabled: true } } } });
  if (policy === "estimated") f.configure();
  await f.success();
  await advance(270_000);
  expect(f.ctx.compact).toHaveBeenCalledTimes(policy === "estimated" ? 1 : 0);
});

it.each(["cache off", "different outgoing model"])(
  "never restores eligibility via an estimate after %s",
  async (cause) => {
    const f = fixture();
    Object.assign(f.ctx.model, {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      compat: { supportsExplicitPromptCacheMode: true },
    });
    await f.success(
      cause === "cache off" ? { prompt_cache_options: { mode: "explicit" } } : { model: "other" },
    );
    await advance(2_000_000);
    expect(f.ctx.compact).not.toHaveBeenCalled();
  },
);

it("uses actual metadata over estimates and refines the early anchor at the payload hook", async () => {
  const f = fixture();
  f.ctx.model.api = "anthropic-messages";
  await f.start();
  await advance(10_000);
  await f.emit("before_provider_request", {
    payload: { cache_control: { type: "ephemeral", ttl: "1h" } },
  });
  f.response();
  await f.emit("agent_settled", { aborted: false });
  await advance(3_230_000);
  expect(f.ctx.compact).not.toHaveBeenCalled();
  await advance(10_000);
  expect(f.ctx.compact).toHaveBeenCalledTimes(1);
});

it.each([
  "input",
  "thinking_level_select",
  "session_before_tree",
  "session_tree",
  "session_before_switch",
  "session_before_fork",
  "user_bash",
  "model_select",
  "ui_prompt_start",
  "session_shutdown",
])("invalidates the candidate on event %s", async (event) => {
  const f = fixture();
  await f.success();
  expect(vi.getTimerCount()).toBe(1);
  await f.emit(event);
  await advance(900_000);
  expect(f.ctx.compact).not.toHaveBeenCalled();
});

it.each([
  "busy",
  "queued",
  "mode",
  "model drift",
  "thinking drift",
  "leaf drift",
  "late clock",
  "backward clock",
  "warming",
  "policy disabled",
  "TTL changed",
  "invalid settings",
])("consumes without retry at launch guard: %s", async (cause) => {
  const f = fixture();
  await f.success();
  expect(vi.getTimerCount()).toBe(1);
  if (cause === "busy") f.ctx.isIdle.mockReturnValue(false);
  if (cause === "queued") f.ctx.hasPendingMessages.mockReturnValue(true);
  if (cause === "mode") f.ctx.mode = "rpc";
  if (cause === "model drift") f.ctx.model.id = "other";
  if (cause === "thinking drift") f.ctx.thinkingLevel = "high";
  if (cause === "leaf drift")
    f.ctx.sessionManager.appendMessage({ role: "user", content: "changed", timestamp: 1 });
  if (cause === "late clock") vi.setSystemTime(2_000_000);
  if (cause === "backward clock") vi.setSystemTime(0);
  if (cause === "warming") settings({ cacheWarming: "idle" });
  if (cause === "policy disabled") settings({ contextRecap: { enabled: false } });
  if (cause === "TTL changed") f.configure("1h");
  if (cause === "invalid settings") writeFileSync(join(agentDir, "settings.json"), "invalid");
  await advance(270_000);
  expect(f.ctx.compact).not.toHaveBeenCalled();
  await advance(900_000);
  expect(f.ctx.compact).not.toHaveBeenCalled();
});

it.each(["input", "before_agent_start"])(
  "gates %s with durable early and in-flight cancellation until native completion",
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
    await f.success();
    await advance(270_000);
    const early = f.emit(gate);
    expect(await f.emit("session_before_compact", event)).toEqual({ cancel: true });
    expect(f.ctx.modelRegistry.complete).not.toHaveBeenCalled();
    f.ctx.compact.mock.calls[0][0].onError();
    await early;
    if (gate === "before_agent_start") await f.emit("agent_settled", { aborted: true });
    await f.success();
    await advance(270_000);
    let resolve!: (value: ReturnType<typeof fauxAssistantMessage>) => void;
    f.ctx.modelRegistry.complete.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const proposal = f.emit("session_before_compact", event);
    const signal = f.ctx.modelRegistry.complete.mock.calls[0][2].signal;
    let continued = false;
    const pending = f.emit(gate).then((result: unknown) => {
      continued = true;
      return result;
    });
    expect(signal.aborted).toBe(true);
    expect(await proposal).toEqual({ cancel: true });
    resolve(
      fauxAssistantMessage(
        "## Objective\nGoal\n## Plan and Progress\nDone\n## Remaining Work\nNone\n## Information Sources\nREADME.md",
      ),
    );
    expect(continued).toBe(false);
    f.ctx.compact.mock.calls[1][0].onError();
    expect(await pending).toEqual(gate === "input" ? { action: "continue" } : undefined);
    expect(continued).toBe(true);
  },
);

it("ignores stale callbacks and releases gates on shutdown", async () => {
  const f = fixture();
  await f.success();
  await advance(270_000);
  const first = f.ctx.compact.mock.calls[0][0];
  first.onComplete();
  await f.success();
  await advance(270_000);
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
  await f.emit("session_shutdown");
});

it.each(["aborted", "wrong physical model", "tool calls", "error", "missed window"])(
  "does not arm unsuccessful/stale settlement: %s",
  async (cause) => {
    const f = fixture();
    await f.start();
    const response = {
      ...fauxAssistantMessage("completed"),
      provider: f.ctx.model.provider,
      model: f.ctx.model.id,
    };
    if (cause === "wrong physical model") response.model = "other";
    if (cause === "tool calls")
      response.content.push({ type: "toolCall", id: "pending", name: "read", arguments: {} });
    if (cause === "error") response.stopReason = "error";
    if (cause === "missed window") await advance(280_000);
    f.ctx.sessionManager.appendMessage(response);
    await f.emit("agent_settled", { aborted: cause === "aborted" });
    await advance(900_000);
    expect(f.ctx.compact).not.toHaveBeenCalled();
  },
);

it("input during a successfully completed run suppresses settlement, then clean work recovers", async () => {
  const f = fixture();
  await f.start();
  await f.emit("input");
  f.response();
  await f.emit("agent_settled", { aborted: false });
  await advance(300_000);
  expect(f.ctx.compact).not.toHaveBeenCalled();
  await f.success();
  await advance(270_000);
  expect(f.ctx.compact).toHaveBeenCalledTimes(1);
});

it("revalidates settings at arming and preserves a thirty-second launch margin", async () => {
  const f = fixture();
  f.configure("1m");
  await f.start();
  settings({ contextRecap: { enabled: false } });
  f.response();
  await f.emit("agent_settled", { aborted: false });
  expect(vi.getTimerCount()).toBe(0);
  f.configure("1m");
  await f.success();
  await advance(29_999);
  expect(f.ctx.compact).not.toHaveBeenCalled();
  await advance(1);
  expect(f.ctx.compact).toHaveBeenCalledTimes(1);
  f.ctx.compact.mock.calls[0][0].onComplete();
  await f.start();
  await advance(40_000);
  f.response();
  await f.emit("agent_settled", { aborted: false });
  expect(vi.getTimerCount()).toBe(0);
  await advance(30_000);
  expect(f.ctx.compact).toHaveBeenCalledTimes(1);
});

it.each(["rpc", "print", "json"])("leaves native %s compaction unchanged", async (mode) => {
  const f = fixture();
  f.ctx.mode = mode;
  await f.command();
  expect(await f.emit("session_before_compact")).toBeUndefined();
  await f.success();
  await advance(300_000);
  expect(f.ctx.compact).not.toHaveBeenCalled();
});

it("status is read-only and rejects arguments without changing eligibility", async () => {
  const f = fixture();
  await f.command();
  expect(f.ctx.ui.notify.mock.lastCall?.[0]).toContain("waiting for a fresh successful run");
  expect(vi.getTimerCount()).toBe(0);
  await f.success();
  await f.command();
  expect(f.ctx.ui.notify.mock.lastCall?.[0]).toContain("scheduled for");
  await f.command("status");
  expect(f.ctx.ui.notify.mock.lastCall?.[1]).toBe("warning");
  await advance(270_000);
  expect(f.ctx.compact).toHaveBeenCalledTimes(1);
});
