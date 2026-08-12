import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetAgentToolRegistryForTests } from "../../_shared/agent-tools";
import { WorkspaceAccess } from "../control";
import { runResolvedSubagentEffect } from "../execute";
import { createSubagentHarness as createHarness } from "./harness";

const state = vi.hoisted(() => ({
  mode: "complete" as "complete" | "blockUntilAbort" | "blockUntilRelease",
  startCount: 0,
  abortCount: 0,
  onBlockedStart: undefined as (() => void) | undefined,
  outputText: undefined as string | undefined,
  releases: [] as Array<() => void>,
}));

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-agent-core")>();
  return {
    ...actual,
    agentLoop: (_prompts: unknown, _context: unknown, _config: unknown, signal: AbortSignal) => ({
      async *[Symbol.asyncIterator]() {
        state.startCount += 1;
        if (state.mode === "blockUntilAbort") {
          state.onBlockedStart?.();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              state.abortCount += 1;
              reject(new Error("cancelled"));
            }, { once: true });
          });
          return;
        }
        if (state.mode === "blockUntilRelease") {
          await new Promise<void>((resolve) => state.releases.push(resolve));
          return;
        }
        yield {
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: state.outputText ?? `done-${state.startCount}` },
            ],
            timestamp: Date.now(),
            model: "test-model",
            stopReason: "stop",
            usage: {
              input: 2,
              output: 3,
              cacheRead: 0,
              cacheWrite: 0,
              cost: { total: 1 },
            },
          },
        };
        yield { type: "turn_end" };
      },
      async result() {
        return [];
      },
    }),
  };
});

const tempDirs: string[] = [];

beforeEach(() => {
  resetAgentToolRegistryForTests();
  state.mode = "complete";
  state.startCount = 0;
  state.abortCount = 0;
  state.onBlockedStart = undefined;
  state.outputText = undefined;
  state.releases = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  resetAgentToolRegistryForTests();
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createContext(cwd: string) {
  const sessionManager = SessionManager.create(cwd, cwd);
  return {
    cwd,
    sessionManager,
    modelRegistry: {
      find: () => ({ provider: "test-provider", id: "test-model" }),
      getAvailable: () => [{ provider: "test-provider", id: "test-model", name: "Test model" }],
      getApiKeyForProvider: async () => "test-key",
    },
  } as any;
}

describe("SubagentSessionRuntime public boundaries", () => {
  it("shares one supervisor across blocking, asynchronous, and direct child runs", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-subagent-shared-supervisor-"));
    tempDirs.push(cwd);
    const settingsDir = join(cwd, ".pi");
    mkdirSync(settingsDir);
    writeFileSync(
      join(settingsDir, "settings.json"),
      JSON.stringify({ subagent: { maxConcurrentRuns: 1, maxPendingRuns: 4 } }),
    );
    const { tools, handlers } = createHarness();
    const ctx = createContext(cwd);
    await handlers.get("session_start")!({ type: "session_start" }, ctx);
    state.mode = "blockUntilRelease";

    const blocking = tools.get("subagent").execute(
      "blocking",
      {
        name: "blocking",
        task: "block",
        tools: ["read"],
        model: "test-provider/test-model",
      },
      undefined,
      undefined,
      ctx,
    );
    await expect.poll(() => state.startCount).toBe(1);

    const asyncJob = await tools.get("subagent_start").execute(
      "async",
      {
        name: "async",
        task: "queue",
        tools: ["read"],
        model: "test-provider/test-model",
      },
      undefined,
      undefined,
      ctx,
    );
    await expect.poll(() => tools.get("subagent_job").execute(
      "async-status",
      { action: "status", job_id: asyncJob.details.jobId },
      undefined,
      undefined,
      ctx,
    ).then((value: any) => value.details.status)).toBe("running");
    await new Promise<void>((resolve) => setImmediate(resolve));

    const direct = Effect.runPromise(
      runResolvedSubagentEffect(
        {
          name: "direct",
          task: "queue direct",
          tools: [],
          toolNames: [],
          model: { provider: "test-provider", id: "test-model" },
          systemPrompt: "Test.",
          cwd,
          workspaceAccess: WorkspaceAccess.Read,
        },
        ctx,
        { runId: "direct" },
      ),
    );
    await Promise.resolve();
    expect(state.startCount).toBe(1);

    state.releases.shift()?.();
    await blocking;
    await expect.poll(() => state.startCount).toBe(2);
    state.releases.shift()?.();
    await tools.get("subagent_job").execute(
      "wait-async",
      { action: "wait", job_id: asyncJob.details.jobId },
      undefined,
      undefined,
      ctx,
    );
    await expect.poll(() => state.startCount).toBe(3);
    state.releases.shift()?.();
    await direct;
    await handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
  });

  it("keeps sync subagent compatible before session_start and resets async jobs/usage across replacement and shutdown", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-subagent-session-runtime-"));
    tempDirs.push(cwd);
    const { tools, handlers } = createHarness();
    const ctx = createContext(cwd);
    const subagent = tools.get("subagent");
    const startTool = tools.get("subagent_start");
    const jobTool = tools.get("subagent_job");
    const startSession = handlers.get("session_start")!;
    const shutdownSession = handlers.get("session_shutdown")!;

    const syncBeforeStart = await subagent.execute(
      "sync-before-start",
      { name: "sync-before", task: "first", tools: ["read"], model: "test-provider/test-model" },
      undefined,
      undefined,
      ctx,
    );
    expect(syncBeforeStart.details.isError).toBe(false);
    expect(syncBeforeStart.content[0]?.type === "text" ? syncBeforeStart.content[0].text : "").toContain("done-");

    await startSession({ type: "session_start" }, ctx);

    const asyncA = await startTool.execute(
      "async-a",
      { name: "async-a", task: "record usage", tools: ["read"], model: "test-provider/test-model" },
      undefined,
      undefined,
      ctx,
    );
    expect(asyncA.details.jobId).toEqual(expect.any(String));

    const waitedA = await jobTool.execute(
      "wait-a",
      { action: "wait", job_id: asyncA.details.jobId },
      undefined,
      undefined,
      ctx,
    );
    expect(waitedA.details.status).toBe("completed");
    expect(waitedA.content[0]?.type === "text" ? waitedA.content[0].text : "").not.toContain(
      "done-",
    );
    const statusA = await jobTool.execute(
      "status-a",
      { action: "status", job_id: asyncA.details.jobId },
      undefined,
      undefined,
      ctx,
    );
    expect(statusA.content[0]?.type === "text" ? statusA.content[0].text : "").not.toContain(
      "done-",
    );
    const resultA = await jobTool.execute(
      "result-a",
      { action: "result", job_id: asyncA.details.jobId },
      undefined,
      undefined,
      ctx,
    );
    expect(resultA.content[0]?.type === "text" ? resultA.content[0].text : "").toContain(
      "done-",
    );

    const usageAfterA = await jobTool.execute("usage-a", { action: "usage" }, undefined, undefined, ctx);
    expect(usageAfterA.content[0]?.text).not.toBe("No subagent usage recorded.");

    state.mode = "blockUntilAbort";
    let unblockObserved!: () => void;
    const blockedStarted = new Promise<void>((resolve) => {
      unblockObserved = resolve;
    });
    state.onBlockedStart = unblockObserved;

    const asyncB = await startTool.execute(
      "async-b",
      { name: "async-b", task: "must cancel", tools: ["read"], model: "test-provider/test-model" },
      undefined,
      undefined,
      ctx,
    );
    await blockedStarted;

    const waitController = new AbortController();
    const interruptedWait = jobTool.execute(
      "wait-old",
      { action: "wait", job_id: asyncB.details.jobId },
      waitController.signal,
      undefined,
      ctx,
    );
    const replaceSession = startSession({ type: "session_start" }, ctx);
    waitController.abort();
    const waitResult = await interruptedWait;
    expect(waitResult.content[0]?.text).toContain("Stopped waiting");
    expect(waitResult.details).toMatchObject({
      jobId: asyncB.details.jobId,
      name: "async-b",
      task: "must cancel",
    });
    await replaceSession;

    const oldList = await jobTool.execute("list-old", { action: "list" }, undefined, undefined, ctx);
    expect(oldList.content[0]?.text).toBe("No subagent jobs.");
    expect(state.abortCount).toBeGreaterThanOrEqual(1);

    const oldStatus = await jobTool.execute(
      "status-old",
      { action: "status", job_id: asyncB.details.jobId },
      undefined,
      undefined,
      ctx,
    ).catch((error: unknown) => error);
    expect(oldStatus).toBeInstanceOf(Error);
    expect((oldStatus as Error).message).toContain(`Unknown subagent job: ${asyncB.details.jobId}`);

    const usageAfterReplace = await jobTool.execute("usage-reset", { action: "usage" }, undefined, undefined, ctx);
    expect(usageAfterReplace.content[0]?.text).toBe("No subagent usage recorded.");

    state.mode = "complete";
    state.onBlockedStart = undefined;
    const asyncC = await startTool.execute(
      "async-c",
      { name: "async-c", task: "fresh session", tools: ["read"], model: "test-provider/test-model" },
      undefined,
      undefined,
      ctx,
    );
    const waitedC = await jobTool.execute(
      "wait-c",
      { action: "wait", job_id: asyncC.details.jobId },
      undefined,
      undefined,
      ctx,
    );
    expect(waitedC.details.status).toBe("completed");

    state.outputText = "large-result-marker" + "x".repeat(100_000);
    const asyncLarge = await startTool.execute(
      "async-large",
      {
        name: "async-large",
        task: "large result",
        tools: ["read"],
        model: "test-provider/test-model",
      },
      undefined,
      undefined,
      ctx,
    );
    await jobTool.execute(
      "wait-large",
      { action: "wait", job_id: asyncLarge.details.jobId },
      undefined,
      undefined,
      ctx,
    );
    const listLarge = await jobTool.execute(
      "list-large",
      { action: "list" },
      undefined,
      undefined,
      ctx,
    );
    expect(listLarge.content[0]?.text).not.toContain("large-result-marker");
    const resultLarge = await jobTool.execute(
      "result-large",
      { action: "result", job_id: asyncLarge.details.jobId },
      undefined,
      undefined,
      ctx,
    );
    const resultLargeText = resultLarge.content[0]?.text ?? "";
    expect(resultLargeText).toContain("large-result-marker");
    expect(resultLargeText).toContain("Output truncated");
    expect(Buffer.byteLength(resultLargeText, "utf8")).toBeLessThan(52_000);

    await shutdownSession({ type: "session_shutdown" }, ctx);
    const usageAfterShutdown = await jobTool.execute("usage-shutdown", { action: "usage" }, undefined, undefined, ctx);
    expect(usageAfterShutdown.content[0]?.text).toBe("No subagent usage recorded.");
  });
});
