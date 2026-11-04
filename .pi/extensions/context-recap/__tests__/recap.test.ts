import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { generateRecap, recapFailureMessage, recapPrompt, validateSummary } from "../recap";
import contextRecap from "../index";
import { withChildContext } from "../../_shared/child-context";

export const validRecap =
  "## Objective\nDeliver the requested feature; no publication approval.\n## Plan and Progress\nUnit check passed; hosted compatibility unverified.\n## Remaining Work\nRun integration checks.\n## Information Sources\nStart at README.md and CONTRIBUTING.md.";

function scenario() {
  const sessionManager = SessionManager.inMemory("/fixture");
  sessionManager.appendMessage({ role: "user", content: "not retained", timestamp: 1 });
  const kept = sessionManager.appendMessage({
    role: "user",
    content: "raw superseded orientation",
    timestamp: 2,
  });
  sessionManager.appendContextEdit(kept, { content: "edited retained orientation" });
  const event = {
    preparation: {
      messagesToSummarize: [{ role: "user", content: "old objective", timestamp: 1 }],
      turnPrefixMessages: [{ role: "user", content: "split pending work", timestamp: 2 }],
      previousSummary: "prior constraints",
      firstKeptEntryId: kept,
      tokensBefore: 42000,
    },
    customInstructions: "preserve approvals",
    signal: new AbortController().signal,
  } as SessionBeforeCompactEvent;
  const complete = vi.fn().mockResolvedValue(fauxAssistantMessage(validRecap));
  const ctx = {
    model: fauxProvider().getModel(),
    modelRegistry: { complete },
    sessionManager,
  };
  return { event, ctx, complete };
}

describe("recap request and validation", () => {
  it("includes prior summary, split prefix and projected retained orientation", () => {
    const { event, ctx } = scenario();
    const prompt = recapPrompt(event, ctx);
    for (const evidence of [
      "old objective",
      "split pending work",
      "prior constraints",
      "edited retained orientation",
      "preserve approvals",
    ])
      expect(prompt).toContain(evidence);
    expect(prompt).not.toContain("not retained");
    expect(prompt).not.toContain("raw superseded orientation");
  });

  it("uses one selected-model request with no cache writes and bounded output", async () => {
    const { event, ctx, complete } = scenario();
    expect((await generateRecap(event, ctx, new AbortController().signal)).summary).toBe(
      validRecap,
    );
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(
      ctx.model,
      expect.anything(),
      expect.objectContaining({
        cacheRetention: "none",
        maxTokens: 4096,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("respects a smaller selected-model output limit", async () => {
    const { event, ctx, complete } = scenario();
    ctx.model.maxTokens = 512;
    await generateRecap(event, ctx, new AbortController().signal);
    expect(complete.mock.calls[0]?.[2].maxTokens).toBe(512);
  });

  it.each(["history", "prefix", "previous summary", "instructions"])(
    "rejects oversized %s before inference instead of trimming it",
    async (source) => {
      const { event, ctx, complete } = scenario();
      ctx.model.contextWindow = 16000;
      const content = "界".repeat(5000);
      if (source === "history")
        event.preparation.messagesToSummarize = [{ role: "user", content, timestamp: 1 }];
      if (source === "prefix")
        event.preparation.turnPrefixMessages = [{ role: "user", content, timestamp: 1 }];
      if (source === "previous summary") event.preparation.previousSummary = content;
      if (source === "instructions") event.customInstructions = content;
      expect(recapPrompt(event, ctx)).toContain(content);
      await expect(generateRecap(event, ctx, new AbortController().signal)).rejects.toThrow(
        "budget exceeded",
      );
      expect(complete).not.toHaveBeenCalled();
    },
  );

  it("reserves output and headroom even when the input alone fits", async () => {
    const { event, ctx, complete } = scenario();
    ctx.model.contextWindow = Buffer.byteLength(recapPrompt(event, ctx), "utf8") + 4096;
    await expect(generateRecap(event, ctx, new AbortController().signal)).rejects.toThrow(
      "budget exceeded",
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([0, -1, NaN, Infinity])("rejects invalid context limit %s", async (limit) => {
    const { event, ctx, complete } = scenario();
    ctx.model.contextWindow = limit;
    await expect(generateRecap(event, ctx, new AbortController().signal)).rejects.toThrow("limits");
    expect(complete).not.toHaveBeenCalled();
  });

  it.each(["error", "aborted", "length", "toolUse"] as const)(
    "rejects %s completions",
    (stopReason) => {
      expect(() => validateSummary(fauxAssistantMessage(validRecap, { stopReason }))).toThrow();
    },
  );

  it.each([
    "",
    "plain text",
    validRecap.replace("## Remaining Work", "## Next Steps"),
    validRecap + "x".repeat(24000),
    validRecap + "\n<read-files>file</read-files>",
  ])("rejects unusable summary %#", (text) => {
    expect(() => validateSummary(fauxAssistantMessage(text))).toThrow();
  });

  it("rejects tool calls even when accompanying text is valid", () => {
    expect(() =>
      validateSummary(
        fauxAssistantMessage([
          { type: "text", text: validRecap },
          fauxToolCall("read", { path: "README.md" }),
        ]),
      ),
    ).toThrow();
  });

  it("honors a deadline even if the provider ignores abort; never retries", async () => {
    const timer = vi.spyOn(globalThis, "setTimeout");
    try {
      const { event, ctx, complete } = scenario();
      complete.mockImplementation(() => new Promise(() => {}));
      const result = generateRecap(event, ctx, new AbortController().signal).catch(
        recapFailureMessage,
      );
      // Fire the registered deadline directly; no elapsed-time scheduling assumption.
      expect(timer.mock.calls[0]?.[1]).toBe(60_000);
      timer.mock.calls[0][0]();
      expect(await result).toContain("deadline exceeded");
      expect(complete).toHaveBeenCalledTimes(1);
      expect(complete.mock.calls[0]?.[2].signal.aborted).toBe(true);
    } finally {
      timer.mockRestore();
    }
  });

  it.each(["compaction", "lifecycle"])(
    "stops waiting on %s cancellation even if inference ignores it",
    async (source) => {
      const { event, ctx, complete } = scenario();
      const compaction = new AbortController();
      const lifecycle = new AbortController();
      event.signal = compaction.signal;
      complete.mockImplementation(() => new Promise(() => {}));
      const pending = generateRecap(event, ctx, lifecycle.signal).catch(recapFailureMessage);
      (source === "compaction" ? compaction : lifecycle).abort();
      expect(await pending).toContain("Activity or cancellation interrupted recap generation");
      expect(complete).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["missing model", "Select a model"],
    ["invalid model", "Select a model"],
    ["budget", "larger-context model"],
    ["summary", "format/completion contract"],
    ["provider result", "availability and authentication"],
    ["provider rejection", "availability and authentication"],
  ])("reports actionable, safe %s failure without fallback", async (source, expected) => {
    const { event, ctx, complete } = scenario();
    const sensitive = "SENSITIVE_SENTINEL_DO_NOT_DISPLAY";
    if (source === "invalid model") ctx.model.maxTokens = 0;
    if (source === "budget") ctx.model.contextWindow = 1;
    if (source === "summary") complete.mockResolvedValue(fauxAssistantMessage(sensitive));
    if (source === "provider result")
      complete.mockResolvedValue(
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: sensitive,
        }),
      );
    if (source === "provider rejection") complete.mockRejectedValue(new Error(sensitive));
    const pi = { on: vi.fn(), registerCommand: vi.fn() };
    contextRecap(pi);
    const hook = pi.on.mock.calls.find(([name]) => name === "session_before_compact")?.[1];
    const notify = vi.fn();
    const result = await hook(event, {
      ...ctx,
      model: source === "missing model" ? undefined : ctx.model,
      mode: "tui",
      hasUI: true,
      ui: { notify },
    });
    expect(result).toEqual({ cancel: true });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining(expected), "warning");
    expect(notify.mock.calls[0]?.[0]).toContain("No recap saved; no fallback request made.");
    expect(JSON.stringify(notify.mock.calls)).not.toContain(sensitive);
    expect(complete.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("does not register commands or hooks in child creation scope", () => {
    const pi = { on: vi.fn(), registerCommand: vi.fn() };
    withChildContext({ cwd: "/fixture", agentDir: "/fixture/agent" }, () => contextRecap(pi));
    expect(pi.on).not.toHaveBeenCalled();
    expect(pi.registerCommand).not.toHaveBeenCalled();
  });

  it("does not call the provider when already cancelled", async () => {
    const { event, ctx, complete } = scenario();
    await expect(generateRecap(event, ctx, AbortSignal.abort())).rejects.toThrow();
    expect(complete).not.toHaveBeenCalled();
  });
});
