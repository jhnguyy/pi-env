import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, getSystemMessageText } from "@earendil-works/pi-ai";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  AgentSessionRuntime,
  InteractiveMode,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
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

async function fixture({
  extra,
  before,
  built = false,
  release = () => {},
}: {
  extra?: (pi: ExtensionAPI) => void;
  before?: (pi: ExtensionAPI) => void;
  built?: boolean;
  release?: () => void;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "context-recap-"));
  let ownedSession: AgentSession | undefined;
  const releases: (() => void)[] = [release];
  onTestFinished(async () => {
    const failures: unknown[] = [];
    const cleanups: (() => void | Promise<void>)[] = [
      () => {
        for (const release of releases) release();
      },
      () => ownedSession?.abort(),
      () => ownedSession?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
      () => ownedSession?.dispose(),
      () => rm(root, { recursive: true, force: true }),
      () => vi.unstubAllEnvs(),
    ];
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "Recap fixture cleanup failed");
  });
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const provider = fauxProvider({ provider: "recap-fixture", tokenSize: { min: 1000, max: 1000 } });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      contextRecap: {
        providers: { [provider.getModel().provider]: { enabled: true, estimatedLifetime: "5m" } },
      },
    }),
  );
  const services = await createAgentSessionServices({
    cwd: root,
    agentDir,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 },
      retry: { enabled: false },
    }),
    resourceLoaderOptions: {
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
    },
  });
  expect(services.diagnostics.filter((item) => item.type === "error")).toEqual([]);
  const sessionManager = SessionManager.create(root, join(root, "sessions"));
  const { session, extensionsResult } = await createAgentSessionFromServices({
    services,
    model: provider.getModel(),
    sessionManager,
    tools: ["read"],
  });
  ownedSession = session;
  expect(extensionsResult.errors).toEqual([]);
  const notifications: string[] = [];
  const errors: unknown[] = [];
  await session.bindExtensions({
    onError: (error) => errors.push(error),
    mode: "tui",
    uiContext: {
      ...session.extensionRunner.getUIContext(),
      notify: (message) => {
        notifications.push(message);
      },
    },
  });
  // Keep SDK IO real; control only the idle scheduler's long timer and wall clock.
  const realSetTimeout = globalThis.setTimeout;
  const candidates: { callback: () => void; handle: NodeJS.Timeout; target: number }[] = [];
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, ms, ...args) => {
    const handle = realSetTimeout(callback, ms, ...args);
    if (ms === 270_000)
      candidates.push({ callback: () => callback(...args), handle, target: now + ms });
    return handle;
  });
  onTestFinished(() => {
    for (const candidate of candidates) clearTimeout(candidate.handle);
    timers.mockRestore();
    clock.mockRestore();
  });
  const fireAutomatic = () => {
    const candidate = candidates.at(-1);
    if (!candidate) throw new Error("Fresh successful run did not schedule recap");
    clearTimeout(candidate.handle);
    now = candidate.target;
    candidate.callback();
  };
  provider.setResponses([fauxAssistantMessage("Earlier evidence ".repeat(100))]);
  await session.prompt("Implement the feature, do not publish.");
  return {
    root,
    agentDir,
    session,
    provider,
    sessionManager,
    services,
    notifications,
    errors,
    candidates,
    fireAutomatic,
    gate: () => {
      const gate = barrier();
      releases.push(gate.resolve);
      return gate;
    },
  };
}

it("built automatic provider policy persists one native recap, retained history and system checkpoint", async () => {
  let prepared: { firstKeptEntryId: string; tokensBefore: number } | undefined;
  let nativeUsage: unknown;
  let payloadHooks = 0;
  const f = await fixture({
    built: true,
    extra: (pi) => {
      pi.on("before_provider_request", () => {
        payloadHooks++;
      });
      pi.on("session_before_compact", (event) => {
        prepared = event.preparation;
      });
      pi.on("session_compact", (event) => {
        nativeUsage = event.compactionEntry.usage;
      });
    },
  });
  const original = f.sessionManager.buildSessionProjection().messages[0];
  if (original?.role !== "system") throw new Error("Missing initial checkpoint");
  f.provider.setResponses([
    fauxAssistantMessage("Fresh retained evidence"),
    fauxAssistantMessage(summary),
  ]);
  await f.session.prompt("Continue without publishing");
  const beforeTokens = f.session.getSessionStats().tokens;
  expect(payloadHooks).toBe(0);
  expect(f.candidates).toHaveLength(2);
  expect(f.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
  const completed = f.gate();
  const unsubscribe = f.session.subscribe((event) => {
    if (event.type === "compaction_end") completed.resolve();
  });
  onTestFinished(unsubscribe);
  f.fireAutomatic();
  await completed.promise;
  await f.session.waitForIdle();
  const reopened = SessionManager.open(
    f.sessionManager.getSessionFile()!,
    join(f.root, "reopened"),
  );
  const saved = reopened.getEntries().filter((entry) => entry.type === "compaction");
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({
    fromHook: true,
    summary,
    firstKeptEntryId: prepared?.firstKeptEntryId,
    tokensBefore: prepared?.tokensBefore,
  });
  expect(saved[0].usage).toEqual(nativeUsage);
  expect(saved[0].usage?.input).toBeGreaterThan(0);
  expect(saved[0].usage?.output).toBeGreaterThan(0);
  expect(saved[0].usage?.cacheWrite).toBe(0);
  expect(f.session.getSessionStats().tokens).toMatchObject({
    input: beforeTokens.input + saved[0].usage!.input,
    output: beforeTokens.output + saved[0].usage!.output,
    cacheRead: beforeTokens.cacheRead + saved[0].usage!.cacheRead,
    cacheWrite: beforeTokens.cacheWrite + saved[0].usage!.cacheWrite,
  });
  const messages = reopened.buildSessionProjection().messages;
  const checkpoint = messages[0];
  if (checkpoint?.role !== "system") throw new Error("Missing reopened checkpoint");
  expect(getSystemMessageText(checkpoint)).toBe(getSystemMessageText(original));
  expect(getSystemMessageText(checkpoint)).toContain(
    "Recap fixture: preserve approval boundaries.",
  );
  expect(checkpoint.toolsAdded).toEqual(original.toolsAdded);
  expect(checkpoint.toolsAdded).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "read" })]),
  );
  expect(
    messages.filter(
      (message) =>
        message.role === "assistant" &&
        message.content.some(
          (part) => part.type === "text" && part.text === "Fresh retained evidence",
        ),
    ),
  ).toHaveLength(1);
  expect(f.provider.state.callCount).toBe(3);
  expect(f.candidates).toHaveLength(2);
  await f.session.prompt("/context-recap");
  expect(f.notifications.at(-1)).toContain("recap saved; waiting for a fresh successful run");
  expect(f.errors).toEqual([]);
});

it.each(["malformed", "over budget"])(
  "cancels %s recap without native fallback or persistence",
  async (source) => {
    const f = await fixture();
    if (source === "over budget") f.session.model!.contextWindow = 512;
    f.provider.setResponses([
      fauxAssistantMessage("malformed"),
      fauxAssistantMessage("must not be requested"),
    ]);
    await expect(f.session.compact()).rejects.toThrow("cancelled");
    expect(f.provider.state.callCount).toBe(source === "over budget" ? 1 : 2);
    expect(f.provider.getPendingResponseCount()).toBe(source === "over budget" ? 2 : 1);
    expect(f.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
  },
);

it("invalidates in-flight inference on thinking change even when the provider ignores abort", async () => {
  const f = await fixture();
  const entered = f.gate();
  const release = f.gate();
  const returned = f.gate();
  const completed = f.gate();
  let signal: AbortSignal | undefined;
  f.session.subscribe((event) => {
    if (event.type === "compaction_end") completed.resolve();
  });
  f.provider.setResponses([
    async (_messages, options) => {
      signal = options?.signal;
      entered.resolve();
      await release.promise;
      returned.resolve();
      return fauxAssistantMessage(summary);
    },
  ]);
  f.fireAutomatic();
  try {
    await entered.promise;
    await f.session.extensionRunner.emit({
      type: "thinking_level_select",
      level: "off",
      previousLevel: "low",
    });
    await completed.promise;
    await f.session.waitForIdle();
    expect(signal?.aborted).toBe(true);
    expect(f.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
    expect(f.provider.state.callCount).toBe(2);
  } finally {
    release.resolve();
  }
  await returned.promise;
  await f.session.waitForIdle();
  const reopened = SessionManager.open(
    f.sessionManager.getSessionFile()!,
    join(f.root, "reopened"),
  );
  expect(reopened.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
  expect(f.errors).toEqual([]);
});

it.each([
  "invalid JSON",
  JSON.stringify({ cacheWarming: "idle", contextRecap: { enabled: false } }),
])("native manual compaction ignores automatic policy %#", async (settings) => {
  const f = await fixture({ built: true });
  await writeFile(join(f.agentDir, "settings.json"), settings);
  f.provider.setResponses([fauxAssistantMessage(summary)]);
  await f.session.compact();
  expect(f.provider.state.callCount).toBe(2);
  expect(f.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(
    1,
  );
  expect(f.errors).toEqual([]);
});

it.each(["ordinary", "bypass", "earlier delayed hook"])(
  "durable same-stack reservation cancellation preserves %s input exactly once",
  async (source) => {
    let api!: ExtensionAPI;
    const entered = barrier();
    const release = barrier();
    const f = await fixture({
      release: release.resolve,
      before:
        source === "earlier delayed hook"
          ? (pi) =>
              pi.on("session_before_compact", async () => {
                entered.resolve();
                await release.promise;
              })
          : undefined,
      extra: (pi) => {
        api = pi;
      },
    });
    let signal: AbortSignal | undefined;
    f.provider.setResponses([
      async (_messages, options) => {
        signal = options?.signal;
        return fauxAssistantMessage("queued work completed");
      },
    ]);
    const completed = f.gate();
    f.session.subscribe((event) => {
      if (event.type === "agent_settled") completed.resolve();
    });
    f.fireAutomatic();
    const submitted =
      source !== "bypass"
        ? f.session.prompt("exactly once after recap")
        : (api.sendMessage(
            { customType: "bypass", content: "exactly once after recap", display: false },
            { triggerTurn: true },
          ),
          undefined);
    try {
      if (source === "earlier delayed hook") {
        await entered.promise;
        expect(f.provider.state.callCount).toBe(1);
      }
    } finally {
      release.resolve();
    }
    await submitted;
    await completed.promise;
    expect(signal?.aborted).toBe(false);
    expect(f.provider.state.callCount).toBe(2);
    expect(f.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
    expect(
      f.sessionManager
        .buildSessionProjection()
        .messages.filter(
          (message) =>
            message.role === (source === "bypass" ? "custom" : "user") &&
            JSON.stringify(message.content).includes("exactly once after recap"),
        ),
    ).toHaveLength(1);
    expect(f.session.getLastAssistantText()).toBe("queued work completed");
    expect(f.errors).toEqual([]);
  },
);

it.each(["thinking change", "native abort"])(
  "retains reservation through late handoff; %s controls native persistence",
  async (source) => {
    const entered = barrier();
    const release = barrier();
    const f = await fixture({
      release: release.resolve,
      extra: (pi) =>
        pi.on("session_before_compact", async () => {
          entered.resolve();
          await release.promise;
        }),
    });
    f.provider.setResponses([fauxAssistantMessage(summary), fauxAssistantMessage("later work")]);
    f.fireAutomatic();
    try {
      await entered.promise;
      await expect(f.session.prompt("during acquired SDK compaction")).rejects.toThrow(
        "compaction is in progress",
      );
      expect(f.provider.state.callCount).toBe(2);
      if (source === "native abort") f.session.abortCompaction();
      else
        await f.session.extensionRunner.emit({
          type: "thinking_level_select",
          level: "off",
          previousLevel: "low",
        });
    } finally {
      release.resolve();
    }
    await f.session.waitForIdle();
    await f.session.prompt("after late native handler");
    expect(f.provider.state.callCount).toBe(3);
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
  },
);

it.each(["consumed", "authentication failure"])(
  "recovers eligibility after %s preflight and a later successful run",
  async (source) => {
    const f = await fixture({
      extra: (pi) =>
        pi.on("input", (event) =>
          event.text === "consumed" ? { action: "handled" } : { action: "continue" },
        ),
    });
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
    f.fireAutomatic();
    expect(f.session.isCompacting).toBe(false);
    expect(f.provider.state.callCount).toBe(1);
    f.provider.setResponses([fauxAssistantMessage("recovered"), fauxAssistantMessage(summary)]);
    await f.session.prompt("later clean input");
    const completed = f.gate();
    f.session.subscribe((event) => {
      if (event.type === "compaction_end") completed.resolve();
    });
    f.fireAutomatic();
    await completed.promise;
    await f.session.waitForIdle();
    expect(f.provider.state.callCount).toBe(3);
    expect(f.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
  },
);

it("suspended downstream preflight prevents automatic acquisition before authentication/run starts", async () => {
  const entered = barrier();
  const release = barrier();
  const f = await fixture({
    release: release.resolve,
    extra: (pi) =>
      pi.on("input", async (event) => {
        if (event.text === "delayed preflight") {
          entered.resolve();
          await release.promise;
        }
        return { action: "continue" };
      }),
  });
  f.provider.setResponses([fauxAssistantMessage("ordinary work")]);
  const submitted = f.session.prompt("delayed preflight");
  try {
    await entered.promise;
    f.fireAutomatic();
    expect(f.session.isCompacting).toBe(false);
  } finally {
    release.resolve();
  }
  await submitted;
  expect(f.provider.state.callCount).toBe(2);
  expect(f.session.getLastAssistantText()).toBe("ordinary work");
});

it("InteractiveMode natively queues acquired-compaction terminal input exactly once", async () => {
  const observedInputs: string[] = [];
  const f = await fixture({
    extra: (pi) =>
      pi.on("input", (event) => {
        observedInputs.push(event.text);
        return { action: "continue" };
      }),
  });
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
  const entered = f.gate();
  const release = f.gate();
  const settled = f.gate();
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
  f.fireAutomatic();
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
