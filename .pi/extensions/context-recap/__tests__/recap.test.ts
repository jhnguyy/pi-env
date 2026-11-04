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
  it("preserves every source through its end and uses the complete edited retained projection", () => {
    const { event, ctx } = scenario();
    const source = (end: string) => "detail ".repeat(5000) + end;
    event.preparation.messagesToSummarize = [
      { role: "user", content: source("HISTORY_END"), timestamp: 1 },
    ];
    event.preparation.turnPrefixMessages = [
      { role: "user", content: source("PREFIX_END"), timestamp: 2 },
    ];
    event.preparation.previousSummary = source("PRIOR_END");
    event.customInstructions = source("OPERATOR_END");
    for (let i = 0; i < 12; i++)
      ctx.sessionManager.appendMessage({
        role: "user",
        content: source(`TAIL_${i}_END`),
        timestamp: i + 3,
      });
    const omitted = ctx.sessionManager.appendMessage({
      role: "user",
      content: "omitted orientation",
      timestamp: 20,
    });
    ctx.sessionManager.appendContextEdit(omitted, null);
    const prompt = recapPrompt(event, ctx);
    for (const evidence of [
      "HISTORY_END",
      "PREFIX_END",
      "PRIOR_END",
      "OPERATOR_END",
      "edited retained orientation",
      ...Array.from({ length: 12 }, (_, i) => `TAIL_${i}_END`),
    ])
      expect(prompt).toContain(evidence);
    expect(prompt).not.toContain("omitted orientation");
    expect(prompt).not.toContain("not retained");
    expect(prompt).not.toContain("raw superseded orientation");
  });

  it("requests no cache writes and bounded output in one selected-model call", async () => {
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
        maxTokens: ctx.model.maxTokens,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it.each([512, 8192])(
    "admits composed input by model capacity and respects output limit %s",
    async (maxTokens) => {
      const { event, ctx, complete } = scenario();
      ctx.model.maxTokens = maxTokens;
      event.preparation.previousSummary = "prior ".repeat(300);
      event.customInstructions = "operator ".repeat(300);
      event.preparation.turnPrefixMessages = [
        { role: "user", content: "split ".repeat(300), timestamp: 2 },
      ];
      ctx.model.contextWindow = 1024;
      await expect(generateRecap(event, ctx, new AbortController().signal)).rejects.toThrow(
        "budget exceeded",
      );
      expect(complete).not.toHaveBeenCalled();
      ctx.model.contextWindow = 4096;
      await generateRecap(event, ctx, new AbortController().signal);
      const output = complete.mock.calls[0]?.[2].maxTokens;
      expect(output).toBeGreaterThan(0);
      expect(output).toBeLessThanOrEqual(maxTokens);
      if (maxTokens === 512) expect(output).toBe(512);
      else expect(output).toBeLessThan(4096);
      expect(complete).toHaveBeenCalledTimes(1);
    },
  );

  it("accepts complete detailed summaries beyond the former character cap", () => {
    const detailed = validRecap + " detail".repeat(5000);
    expect(validateSummary(fauxAssistantMessage(detailed))).toBe(detailed);
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

  it("accepts healthy completion after more than 60 seconds without a total deadline", async () => {
    vi.stubGlobal("Temporal", undefined);
    vi.useFakeTimers();
    try {
      const { event, ctx, complete } = scenario();
      let resolve!: (value: ReturnType<typeof fauxAssistantMessage>) => void;
      complete.mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const result = generateRecap(event, ctx, new AbortController().signal);
      const settled = result.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(120_001);
      expect(complete.mock.calls[0]?.[2].signal.aborted).toBe(false);
      resolve(fauxAssistantMessage(validRecap));
      expect(await settled).toMatchObject({ summary: validRecap });
      expect(complete).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
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
    expect(complete).toHaveBeenCalledTimes(
      ["missing model", "invalid model", "budget"].includes(source) ? 0 : 1,
    );
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
