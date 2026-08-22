import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type * as AgentCore from "@earendil-works/pi-agent-core";
import type { Text } from "@earendil-works/pi-tui";
import { Container } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetAgentToolRegistryForTests } from "../../_shared/agent-tools";
import { createSubagentHarness as createHarness } from "./harness";

const state = vi.hoisted(() => ({
  mode: "complete",
  startCount: 0,
  abortCount: 0,
  onBlockedStart: undefined as (() => void) | undefined,
}));

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  const actual = await importOriginal<typeof AgentCore>();
  return {
    ...actual,
    agentLoop: (_prompts: unknown, _context: unknown, _config: unknown, signal: AbortSignal) => ({
      async *[Symbol.asyncIterator]() {
        state.startCount += 1;
        if (state.mode === "blockUntilAbort") {
          state.onBlockedStart?.();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                state.abortCount += 1;
                reject(new Error("cancelled"));
              },
              { once: true },
            );
          });
          return;
        }
        if (state.mode === "fail") throw new Error("test failure");
        yield {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: `done-${state.startCount}` }],
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
});
afterEach(() => {
  vi.restoreAllMocks();
  resetAgentToolRegistryForTests();
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function extractText(component: Text | Container): string {
  if (component instanceof Container) {
    return component.children.map((child: any) => extractText(child)).join("\n");
  }
  return (component as any).text ?? "";
}

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
    expect(syncBeforeStart.content).toEqual([{ type: "text", text: "done-1" }]);

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
    expect(waitedA.content).toEqual([{ type: "text", text: "done-2" }]);
    expect(waitedA.details).toMatchObject({
      jobId: asyncA.details.jobId,
      status: "completed",
      usage: { input: 2, output: 3, turns: 1 },
      sessionName: "sub-async-a",
      sessionFile: expect.any(String),
      resultTruncated: false,
    });

    const resultA = await jobTool.execute(
      "result-a",
      { action: "result", job_id: asyncA.details.jobId },
      undefined,
      undefined,
      ctx,
    );
    expect(resultA.content).toEqual([{ type: "text", text: "done-2" }]);
    expect(resultA.details).toMatchObject({ jobId: asyncA.details.jobId, status: "completed" });

    const renderedResult = extractText(
      jobTool.renderResult(
        { ...resultA, details: { ...resultA.details, resultTruncated: true } },
        {},
        { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      ),
    );
    expect(renderedResult).toContain(asyncA.details.jobId);
    expect(renderedResult).toContain("completed");
    expect(renderedResult).toContain("1 turn");
    expect(renderedResult).toContain(resultA.details.sessionFile);
    expect(renderedResult).toContain("result truncated");

    const usageAfterA = await jobTool.execute(
      "usage-a",
      { action: "usage" },
      undefined,
      undefined,
      ctx,
    );
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
    waitController.abort();
    const waitResult = await interruptedWait;
    expect(waitResult.content[0]?.text).toContain("Stopped waiting");
    expect(waitResult.content[0]?.text).not.toContain("done-");
    expect(waitResult.details).toMatchObject({
      jobId: asyncB.details.jobId,
      status: "running",
      name: "async-b",
      task: "must cancel",
    });
    const preservedJob = await jobTool.execute(
      "status-preserved",
      { action: "status", job_id: asyncB.details.jobId },
      undefined,
      undefined,
      ctx,
    );
    expect(preservedJob.details.status).toBe("running");

    await startSession({ type: "session_start" }, ctx);

    const oldList = await jobTool.execute(
      "list-old",
      { action: "list" },
      undefined,
      undefined,
      ctx,
    );
    expect(oldList.content[0]?.text).toBe("No subagent jobs.");
    expect(state.abortCount).toBeGreaterThanOrEqual(1);

    const oldStatus = await jobTool
      .execute(
        "status-old",
        { action: "status", job_id: asyncB.details.jobId },
        undefined,
        undefined,
        ctx,
      )
      .catch((error: unknown) => error);
    expect(oldStatus).toBeInstanceOf(Error);
    expect((oldStatus as Error).message).toContain(`Unknown subagent job: ${asyncB.details.jobId}`);

    const usageAfterReplace = await jobTool.execute(
      "usage-reset",
      { action: "usage" },
      undefined,
      undefined,
      ctx,
    );
    expect(usageAfterReplace.content[0]?.text).toBe("No subagent usage recorded.");

    state.mode = "fail";
    state.onBlockedStart = undefined;
    const failed = await startTool.execute(
      "async-failed",
      { name: "async-failed", task: "fail", tools: ["read"], model: "test-provider/test-model" },
      undefined,
      undefined,
      ctx,
    );
    const waitedFailure = await jobTool.execute(
      "wait-failed",
      { action: "wait", job_id: failed.details.jobId },
      undefined,
      undefined,
      ctx,
    );
    expect(waitedFailure.details.status).toBe("failed");
    expect(waitedFailure.content[0]?.text).toContain("[failed]");
    expect(waitedFailure.content[0]?.text).not.toContain("done-");

    state.mode = "complete";
    const asyncC = await startTool.execute(
      "async-c",
      {
        name: "async-c",
        task: "fresh session",
        tools: ["read"],
        model: "test-provider/test-model",
      },
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
    expect(waitedC.content[0]?.text).toMatch(/^done-/);

    await shutdownSession({ type: "session_shutdown" }, ctx);
    const usageAfterShutdown = await jobTool.execute(
      "usage-shutdown",
      { action: "usage" },
      undefined,
      undefined,
      ctx,
    );
    expect(usageAfterShutdown.content[0]?.text).toBe("No subagent usage recorded.");
  });
});
