import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, getSystemMessageText } from "@earendil-works/pi-ai";
import {
  createAgentSession,
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
  return { root, agentDir, session, provider, sessionManager, notifications, errors };
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
  f.session.model!.contextWindow = 4096;
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

it("loads the built bundle with no settings surface or automatic mode", async () => {
  const f = await fixture(undefined, "tui", true);
  await writeFile(join(f.agentDir, "settings.json"), "invalid JSON: status must not read settings");
  await f.session.prompt("/context-recap status");
  expect(f.notifications.at(-1)).toBe(
    "Root TUI recap customization active; automatic recap blocked (no atomic idle-only compaction API).",
  );
  expect(f.errors).toEqual([]);
  for (const action of ["on", "off"]) {
    await f.session.prompt(`/context-recap ${action}`);
    expect(f.notifications.at(-1)).toBe("Usage: /context-recap status|now|cancel");
  }
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
