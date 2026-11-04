import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, getSystemMessageText } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  AgentSessionRuntime,
  InteractiveMode,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import contextRecap from "../index";

const summary =
  "## Objective\nImplement recap.\n## Plan and Progress\nNative fixture completed.\n## Remaining Work\nQualify hosted providers.\n## Information Sources\nREADME.md.";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(
  extra?: (pi: ExtensionAPI) => void,
  mode: "tui" | "print" = "tui",
  built = false,
  before?: (pi: ExtensionAPI) => void,
) {
  const root = await mkdtemp(join(tmpdir(), "context-recap-"));
  let ownedSession: AgentSession | undefined;
  onTestFinished(async () => {
    try {
      await ownedSession?.abort();
    } finally {
      try {
        ownedSession?.dispose();
      } finally {
        try {
          await rm(root, { recursive: true, force: true });
        } finally {
          vi.unstubAllEnvs();
        }
      }
    }
  });
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const provider = fauxProvider({ provider: "recap-fixture", tokenSize: { min: 1000, max: 1000 } });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 },
    retry: { enabled: false },
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => "Recap fixture: preserve approval boundaries.",
    additionalExtensionPaths: built
      ? [fileURLToPath(new URL("../dist/index.js", import.meta.url))]
      : [],
    extensionFactories: [
      (pi) => pi.registerProvider(provider.provider),
      ...(before ? [before] : []),
      ...(built ? [] : [contextRecap]),
      ...(extra ? [extra] : []),
    ],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const sessionManager = SessionManager.create(root, join(root, "sessions"));
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    modelRuntime,
    model: provider.getModel(),
    resourceLoader: loader,
    settingsManager,
    sessionManager,
    tools: ["read"],
  });
  ownedSession = session;
  const notifications: string[] = [];
  const errors: unknown[] = [];
  await session.bindExtensions({
    onError: (error) => errors.push(error),
    mode,
    uiContext: { notify: (message: string) => notifications.push(message) } as never,
  });
  provider.setResponses([fauxAssistantMessage("Earlier evidence ".repeat(100))]);
  await session.prompt("Implement the feature, do not publish.");
  return {
    root,
    agentDir,
    session,
    provider,
    sessionManager,
    notifications,
    errors,
    services: {
      cwd: root,
      agentDir,
      modelRuntime,
      settingsManager,
      resourceLoader: loader,
      diagnostics: [],
    },
  };
}

it("persists a custom recap with native retained history and system checkpoint", async () => {
  let prepared: { firstKeptEntryId: string; tokensBefore: number } | undefined;
  const f = await fixture((pi) =>
    pi.on("session_before_compact", (event) => {
      prepared = event.preparation;
    }),
  );
  const original = f.sessionManager.buildSessionProjection().messages[0];
  if (original?.role !== "system") throw new Error("Missing initial system message");
  f.provider.setResponses([fauxAssistantMessage(summary)]);
  const result = await f.session.compact();
  expect(result.summary).toBe(summary);
  expect(result.firstKeptEntryId).toBe(prepared?.firstKeptEntryId);
  expect(result.tokensBefore).toBe(prepared?.tokensBefore);
  const entry = f.sessionManager.getEntries().find((item) => item.type === "compaction");
  expect(entry).toMatchObject({
    fromHook: true,
    summary,
    firstKeptEntryId: result.firstKeptEntryId,
  });
  expect(entry && "systemMessage" in entry && entry.systemMessage).toBeTruthy();
  const reopened = SessionManager.open(
    f.sessionManager.getSessionFile()!,
    join(f.sessionManager.getCwd(), "reopened"),
  );
  const messages = reopened.buildSessionProjection().messages;
  const checkpoint = messages[0];
  expect(checkpoint?.role).toBe("system");
  if (checkpoint?.role !== "system") throw new Error("Missing reopened system checkpoint");
  expect(getSystemMessageText(checkpoint)).toContain(
    "Recap fixture: preserve approval boundaries.",
  );
  expect(checkpoint.toolsAdded).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "read" })]),
  );
  expect(checkpoint.toolsAdded).toEqual(original.toolsAdded);
  expect(getSystemMessageText(checkpoint)).toBe(getSystemMessageText(original));
  expect(messages).toContainEqual(
    expect.objectContaining({
      role: "assistant",
      content: [{ type: "text", text: "Earlier evidence ".repeat(100) }],
    }),
  );
  const saved = reopened.getEntries().find((item) => item.type === "compaction");
  expect(saved?.summary).toBe(summary);
  expect(saved?.usage).toEqual(result.usage);
  expect(saved?.usage?.input).toBeGreaterThan(0);
  expect(saved?.usage?.output).toBeGreaterThan(0);
  expect(saved?.usage?.cacheWrite).toBe(0);
  expect(f.provider.state.callCount).toBe(2);
});

it("automatically persists exactly one native recap with a user estimate and no payload hook", async () => {
  let payloadHooks = 0;
  const f = await fixture(
    (pi) =>
      pi.on("before_provider_request", () => {
        payloadHooks++;
      }),
    "tui",
    true,
  );
  const realSetTimeout = globalThis.setTimeout;
  const candidates: { callback: () => void; handle: number | NodeJS.Timeout }[] = [];
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    ms: number,
    ...args: unknown[]
  ) => {
    const handle = realSetTimeout(callback, ms, ...args);
    if (ms === 270_000) candidates.push({ callback, handle });
    return handle;
  }) as typeof setTimeout);
  onTestFinished(() => {
    for (const candidate of candidates) clearTimeout(candidate.handle);
    timers.mockRestore();
    clock.mockRestore();
  });
  await f.session.prompt("/context-recap on 5m");
  f.provider.setResponses([
    fauxAssistantMessage("Fresh retained evidence"),
    fauxAssistantMessage(summary),
  ]);
  await f.session.prompt("Continue without publishing");
  expect(payloadHooks).toBe(0);
  expect(candidates).toHaveLength(1);
  expect(f.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(
    0,
  );
  const completed = barrier();
  let nativeCompletions = 0;
  const unsubscribe = f.session.subscribe((event) => {
    if (event.type === "compaction_end") {
      nativeCompletions++;
      completed.resolve();
    }
  });
  onTestFinished(unsubscribe);
  const candidate = candidates[0];
  clearTimeout(candidate.handle);
  now += 270_000;
  candidate.callback();
  await completed.promise;
  await f.session.waitForIdle();
  const reopened = SessionManager.open(
    f.sessionManager.getSessionFile()!,
    join(f.root, "reopened"),
  );
  const saved = reopened.getEntries().filter((entry) => entry.type === "compaction");
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ fromHook: true, summary });
  expect(saved[0]?.usage?.input).toBeGreaterThan(0);
  expect(saved[0]?.usage?.output).toBeGreaterThan(0);
  expect(saved[0]?.usage?.cacheWrite).toBe(0);
  expect(reopened.buildSessionProjection().messages).toContainEqual(
    expect.objectContaining({
      role: "assistant",
      content: [{ type: "text", text: "Fresh retained evidence" }],
    }),
  );
  expect(nativeCompletions).toBe(1);
  expect(f.provider.state.callCount).toBe(3);
  expect(candidates).toHaveLength(1);
  await f.session.prompt("/context-recap status");
  expect(f.notifications.at(-1)).toContain("recap saved; waiting for a fresh successful run");
  expect(f.errors).toEqual([]);
});

it("cancels malformed recap without native fallback or persisted compaction", async () => {
  const f = await fixture();
  f.provider.setResponses([
    fauxAssistantMessage("malformed"),
    fauxAssistantMessage("must not be requested"),
  ]);
  await expect(f.session.compact()).rejects.toThrow("cancelled");
  expect(f.provider.state.callCount).toBe(2);
  expect(f.provider.getPendingResponseCount()).toBe(1);
  expect(f.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
});

it("rejects over-budget recap without a provider call or native fallback", async () => {
  const f = await fixture();
  f.session.model!.contextWindow = 512;
  f.provider.setResponses([fauxAssistantMessage("must not be requested")]);
  await expect(f.session.compact()).rejects.toThrow("cancelled");
  expect(f.provider.state.callCount).toBe(1);
  expect(f.provider.getPendingResponseCount()).toBe(1);
  expect(f.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
});

it.each(["thinking change", "cancel command"])(
  "invalidates an in-flight recap on %s",
  async (source) => {
    const f = await fixture();
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.provider.setResponses([
      async () => {
        started();
        await gate;
        return fauxAssistantMessage(summary);
      },
    ]);
    const compacted = expect(f.session.compact()).rejects.toThrow("cancelled");
    try {
      await ready;
      if (source === "cancel command") {
        await f.session.prompt("/context-recap cancel");
        expect(f.notifications).toContain("Active context recap cancelled.");
      } else {
        await f.session.extensionRunner.emit({
          type: "thinking_level_select",
          level: "off",
          previousLevel: "low",
        });
      }
      await compacted;
      expect(f.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(
        false,
      );
      expect(f.provider.state.callCount).toBe(2);
    } finally {
      release();
    }
  },
);

it("loads the built bundle with automatic mode default off and manual recap independent of settings", async () => {
  const f = await fixture(undefined, "tui", true);
  await writeFile(join(f.agentDir, "settings.json"), "invalid JSON: status must not read settings");
  await f.session.prompt("/context-recap status");
  expect(f.notifications.at(-1)).toContain("Automatic context recap off");
  expect(f.errors).toEqual([]);
  await f.session.prompt("/context-recap on 5m");
  expect(f.notifications.at(-1)).toContain("user estimate");
  await f.session.prompt("/context-recap off");
  expect(f.notifications.at(-1)).toBe("Automatic context recap off.");
  await f.session.prompt("/context-recap cancel");
  expect(f.notifications.at(-1)).toBe("No active context recap to cancel.");
  f.provider.setResponses([fauxAssistantMessage("fresh real turn")]);
  await f.session.prompt("Continue the task");
  expect(f.provider.state.callCount).toBe(2);
  expect(f.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
  f.provider.setResponses([fauxAssistantMessage(summary)]);
  const completed = new Promise<void>((resolve) =>
    f.session.subscribe((event) => {
      if (event.type === "compaction_end") resolve();
    }),
  );
  await f.session.prompt("/context-recap now");
  await completed;
  expect(f.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
  expect(f.provider.state.callCount).toBe(3);
});

it("does not cancel ordinary agent work when no recap is active", async () => {
  const f = await fixture();
  let started!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signal: AbortSignal | undefined;
  f.provider.setResponses([
    async (_messages, options) => {
      signal = options?.signal;
      started();
      await gate;
      return fauxAssistantMessage("ordinary work finished");
    },
  ]);
  const prompt = f.session.prompt("Continue ordinary work");
  try {
    await ready;
    await f.session.prompt("/context-recap cancel");
    expect(f.notifications.at(-1)).toBe("No active context recap to cancel.");
    expect(signal?.aborted).toBe(false);
  } finally {
    release();
    await prompt;
  }
  expect(f.provider.state.callCount).toBe(2);
  const messages = f.sessionManager.buildSessionProjection().messages;
  expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
});

it.each(["ordinary", "bypass"])(
  "early reservation cancellation preserves a same-stack %s prompt exactly once",
  async (source) => {
    let api!: ExtensionAPI;
    let requestSignal: AbortSignal | undefined;
    const f = await fixture((pi) => {
      api = pi;
    });
    f.provider.setResponses([
      async (_messages, options) => {
        requestSignal = options?.signal;
        return fauxAssistantMessage("queued work completed");
      },
    ]);
    const completed = barrier();
    f.session.subscribe((event) => {
      if (event.type === "agent_settled") completed.resolve();
    });
    const command = f.session.prompt("/context-recap now");
    const submitted =
      source === "ordinary"
        ? f.session.prompt("exactly once after recap")
        : (api.sendMessage(
            { customType: "bypass", content: "exactly once after recap", display: false },
            { triggerTurn: true },
          ),
          undefined);
    await command;
    await submitted;
    await completed.promise;
    expect(requestSignal?.aborted).toBe(false);
    expect(f.provider.state.callCount).toBe(2); // Initial turn + prompt, zero recap inference.
    expect(f.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
    const messages = f.sessionManager.buildSessionProjection().messages;
    expect(
      messages.filter(
        (message) =>
          message.role === (source === "ordinary" ? "user" : "custom") &&
          JSON.stringify(message.content).includes("exactly once after recap"),
      ),
    ).toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
    expect(f.errors).toEqual([]);
  },
);

it("preserves early input cancellation across an earlier delayed native compaction hook", async () => {
  const entered = barrier();
  const release = barrier();
  const f = await fixture(undefined, "tui", false, (pi) =>
    pi.on("session_before_compact", async () => {
      entered.resolve();
      await release.promise;
    }),
  );
  f.provider.setResponses([fauxAssistantMessage("ordinary work after delayed hook")]);
  const command = f.session.prompt("/context-recap now");
  // Input reaches our gate before native acquisition. The earlier hook then delays
  // recap's hook, proving that hook entry cannot reset the reservation marker.
  const submitted = f.session.prompt("work after delayed hook");
  try {
    await entered.promise;
    expect(f.provider.state.callCount).toBe(1);
  } finally {
    release.resolve();
  }
  await command;
  await submitted;
  expect(f.provider.state.callCount).toBe(2);
  expect(f.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
  expect(f.session.getLastAssistantText()).toBe("ordinary work after delayed hook");
  expect(f.sessionManager.buildSessionProjection().messages.at(-1)).toMatchObject({
    stopReason: "stop",
  });
});

it("retains reservation through late native handlers and does not claim to retract a proposal", async () => {
  const entered = barrier();
  const release = barrier();
  const f = await fixture((pi) =>
    pi.on("session_before_compact", async () => {
      entered.resolve();
      await release.promise;
    }),
  );
  f.provider.setResponses([fauxAssistantMessage(summary), fauxAssistantMessage("later work")]);
  await f.session.prompt("/context-recap now");
  await entered.promise;
  await f.session.prompt("/context-recap status");
  expect(f.notifications.at(-1)).toContain("handed-off");
  await f.session.prompt("/context-recap off");
  expect(f.notifications.at(-1)).toContain("Automatic context recap off.");
  expect(f.notifications.at(-1)).toContain("cannot retract");
  const compacted = barrier();
  f.session.subscribe((event) => {
    if (event.type === "compaction_end") compacted.resolve();
  });
  try {
    await expect(f.session.prompt("during acquired SDK compaction")).rejects.toThrow(
      "compaction is in progress",
    );
    expect(f.provider.state.callCount).toBe(2);
  } finally {
    release.resolve();
  }
  await compacted.promise;
  await f.session.waitForIdle();
  await f.session.prompt("after late native handler");
  expect(f.provider.state.callCount).toBe(3);
  expect(f.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
  expect(f.errors).toEqual([]);
});

it.each(["consumed", "authentication failure"])(
  "recovers manual eligibility after %s preflight and a later successful native run",
  async (source) => {
    const f = await fixture((pi) =>
      pi.on("input", (event) =>
        event.text === "consumed" ? { action: "handled" } : { action: "continue" },
      ),
    );
    if (source === "consumed") await f.session.prompt("consumed");
    else {
      const configured = vi
        .spyOn(f.services.modelRuntime, "hasConfiguredAuth")
        .mockReturnValueOnce(false);
      const auth = vi.spyOn(f.services.modelRuntime, "checkAuth").mockResolvedValueOnce(undefined);
      try {
        await expect(f.session.prompt("fails before run start")).rejects.toThrow("No API key");
      } finally {
        auth.mockRestore();
        configured.mockRestore();
      }
    }
    await f.session.prompt("/context-recap now");
    expect(f.notifications.at(-1)).toContain("must be idle");
    expect(f.provider.state.callCount).toBe(1);
    f.provider.setResponses([fauxAssistantMessage("recovered"), fauxAssistantMessage(summary)]);
    await f.session.prompt("later clean input");
    const completed = barrier();
    f.session.subscribe((event) => {
      if (event.type === "compaction_end") completed.resolve();
    });
    await f.session.prompt("/context-recap now");
    await completed.promise;
    expect(f.provider.state.callCount).toBe(3);
    expect(f.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
  },
);

it("suspended downstream input preflight prevents manual acquisition before authentication/run starts", async () => {
  const entered = barrier();
  const release = barrier();
  const f = await fixture((pi) =>
    pi.on("input", async (event) => {
      if (event.text === "delayed preflight") {
        entered.resolve();
        await release.promise;
      }
      return { action: "continue" };
    }),
  );
  f.provider.setResponses([fauxAssistantMessage("ordinary work")]);
  const submitted = f.session.prompt("delayed preflight");
  try {
    await entered.promise;
    await f.session.prompt("/context-recap now");
    expect(f.notifications.at(-1)).toContain("must be idle");
    expect(f.session.isCompacting).toBe(false);
  } finally {
    release.resolve();
  }
  await submitted;
  expect(f.provider.state.callCount).toBe(2);
  expect(f.session.getLastAssistantText()).toBe("ordinary work");
});

it("InteractiveMode queues ordinary terminal submission during acquired compaction and runs it once", async () => {
  const observedInputs: string[] = [];
  const f = await fixture((pi) =>
    pi.on("input", (event) => {
      observedInputs.push(event.text);
      return { action: "continue" };
    }),
  );
  const runtime = new AgentSessionRuntime(f.session, f.services, async () => {
    throw new Error("No replacement in this fixture");
  });
  let input!: (data: string) => void;
  const noop = () => {};
  const terminal = {
    start: (onInput: (data: string) => void) => {
      input = onInput;
    },
    stop: noop,
    drainInput: async () => {},
    write: noop,
    columns: 100,
    rows: 30,
    kittyProtocolActive: false,
    moveBy: noop,
    hideCursor: noop,
    showCursor: noop,
    clearLine: noop,
    clearFromCursor: noop,
    clearScreen: noop,
    setTitle: noop,
    setProgress: noop,
    setProgramStatus: noop,
  };
  const interactive = new InteractiveMode(runtime, { terminal, tuiMode: "fullscreen" });
  onTestFinished(() => interactive.stop());
  await interactive.init();
  const entered = barrier();
  const release = barrier();
  const settled = barrier();
  f.session.subscribe((event) => {
    if (event.type === "agent_settled") settled.resolve();
  });
  f.provider.setResponses([
    async () => {
      entered.resolve();
      await release.promise;
      return fauxAssistantMessage(summary);
    },
    fauxAssistantMessage("terminal work completed"),
  ]);
  await f.session.prompt("/context-recap now");
  try {
    await entered.promise;
    input("terminal queued exactly once");
    input("\r");
    expect(observedInputs).not.toContain("terminal queued exactly once");
    expect(f.session.isCompacting).toBe(true);
    expect(f.provider.state.callCount).toBe(2);
  } finally {
    release.resolve();
  }
  await settled.promise;
  expect(f.provider.state.callCount).toBe(3);
  expect(
    f.sessionManager
      .buildSessionProjection()
      .messages.filter(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message.content).includes("terminal queued exactly once"),
      ),
  ).toHaveLength(1);
  expect(f.session.getLastAssistantText()).toBe("terminal work completed");
  expect(observedInputs.filter((text) => text === "terminal queued exactly once")).toHaveLength(1);
});

it("establishes that native compact aborts work before the compaction hook can cancel", async () => {
  let context!: ExtensionContext;
  const f = await fixture((pi) => {
    pi.on("agent_settled", (_event, ctx) => {
      context = ctx;
    });
    pi.on("session_before_compact", () => ({ cancel: true }));
  }, "print");
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.provider.setResponses([
    async (_messages, options) => {
      started();
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      return fauxAssistantMessage("interrupted", { stopReason: "aborted" });
    },
  ]);
  const prompt = f.session.prompt("Keep working");
  await ready;
  expect(context.isIdle()).toBe(false);
  const finished = new Promise<void>((resolve) => context.compact({ onError: () => resolve() }));
  await finished;
  await prompt;
  const assistants = f.sessionManager
    .buildSessionProjection()
    .messages.filter((message) => message.role === "assistant");
  expect(assistants.at(-1)?.stopReason).toBe("aborted");
  expect(f.provider.state.callCount).toBe(2);
});

it.each([true, false])(
  "qualifies native idle-check/compact overlap (competing prompt: %s)",
  async (competingPrompt) => {
    let context!: ExtensionContext;
    const entered = barrier();
    const release = barrier();
    let providerEntered = false;
    let providerReleased = false;
    let signal: AbortSignal | undefined;
    let observed: unknown;
    const f = await fixture((pi) => {
      pi.on("agent_settled", (_event, ctx) => {
        context = ctx;
      });
      pi.on("session_before_compact", async (_event, ctx) => {
        if (competingPrompt) await entered.promise;
        observed = {
          streaming: f.session.isStreaming,
          idle: ctx.isIdle(),
          providerEntered,
          providerReleased,
          aborted: signal?.aborted,
        };
        return { cancel: true };
      });
    }, "print");
    f.provider.setResponses([
      async (_messages, options) => {
        signal = options?.signal;
        providerEntered = true;
        entered.resolve();
        await release.promise;
        providerReleased = true;
        return fauxAssistantMessage("new user work");
      },
    ]);
    const compactDone = barrier();
    let prompt: Promise<void> | undefined;
    try {
      // Keep the check adjacent to compact: native abort() yields before acquisition.
      expect(context.isIdle()).toBe(true);
      context.compact({
        onError: () => compactDone.resolve(),
        onComplete: () => compactDone.resolve(),
      });
      if (competingPrompt) prompt = f.session.prompt("A new prompt arrived");
      await compactDone.promise;
      expect(observed).toEqual({
        streaming: competingPrompt,
        idle: false,
        providerEntered: competingPrompt,
        providerReleased: false,
        aborted: competingPrompt ? false : undefined,
      });
    } finally {
      release.resolve();
      await Promise.all([compactDone.promise, prompt]);
    }
    expect(f.provider.state.callCount).toBe(competingPrompt ? 2 : 1);
    if (competingPrompt) {
      expect(f.sessionManager.buildSessionProjection().messages.at(-1)).toMatchObject({
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "new user work" }],
      });
    }
    expect(f.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
  },
);

it.each(["thinking change", "native abort"])(
  "qualifies %s after recap returns but before native commit",
  async (source) => {
    const entered = barrier();
    const release = barrier();
    const f = await fixture((pi) => {
      pi.on("session_before_compact", async () => {
        entered.resolve();
        await release.promise;
        // An undefined result preserves recap's already-returned proposal.
      });
    });
    f.provider.setResponses([fauxAssistantMessage(summary)]);
    const compacted = f.session.compact();
    const outcome =
      source === "native abort"
        ? expect(compacted).rejects.toThrow("cancelled")
        : expect(compacted).resolves.toMatchObject({ summary });
    try {
      await entered.promise;
      await f.session.prompt("/context-recap cancel");
      expect(f.notifications.at(-1)).toBe("No active context recap to cancel.");
      if (source === "native abort") f.session.abortCompaction();
      else
        await f.session.extensionRunner.emit({
          type: "thinking_level_select",
          level: "off",
          previousLevel: "low",
        });
    } finally {
      release.resolve();
      await outcome;
    }
    const reopened = SessionManager.open(
      f.sessionManager.getSessionFile()!,
      join(f.root, "reopened"),
    );
    expect(
      reopened
        .getEntries()
        .filter((entry) => entry.type === "compaction")
        .map((entry) => entry.summary),
    ).toEqual(source === "native abort" ? [] : [summary]);
    expect(f.provider.state.callCount).toBe(2);
  },
);
