import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { resetAgentToolRegistryForTests } from "../../_shared/agent-tools";
import { createSubagentHarness as createHarness } from "./harness";
import { SubagentJobManager } from "../jobs";

const temporaryDirectories: string[] = [];

beforeEach(() => resetAgentToolRegistryForTests());
afterEach(() => {
  vi.restoreAllMocks();
  resetAgentToolRegistryForTests();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function sessionContext(cwd: string) {
  return {
    cwd,
    sessionManager: SessionManager.inMemory(cwd),
    modelRegistry: {
      getAvailable: () => [],
    },
  } as any;
}

describe("subagent extension session lifecycle", () => {
  it("does not let a stale session_start reactivate after a newer shutdown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-subagent-lifecycle-"));
    temporaryDirectories.push(directory);
    const harness = createHarness();
    const startSession = harness.handlers.get("session_start")!;
    const shutdownSession = harness.handlers.get("session_shutdown")!;
    const startTool = harness.tools.get("subagent_start");
    const jobTool = harness.tools.get("subagent_job");
    const ctx = sessionContext(directory);
    await startSession({ type: "session_start" }, ctx);

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let oldManager: SubagentJobManager | undefined;
    const originalShutdown = SubagentJobManager.prototype.shutdown;
    vi.spyOn(SubagentJobManager.prototype, "shutdown").mockImplementationOnce(function (this: SubagentJobManager) {
      oldManager = this;
      return blocked;
    });

    const staleStart = startSession({ type: "session_start" }, ctx);
    await Promise.resolve();
    let shutdownSettled = false;
    const shutdown = shutdownSession({ type: "session_shutdown" }, ctx).then(() => {
      shutdownSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(shutdownSettled).toBe(false);
    release();
    await Promise.all([staleStart, shutdown]);

    const result = await startTool.execute("after", { name: "after", task: "x" }, undefined, undefined, ctx);
    expect(result.details).toMatchObject({ status: "inactive", name: "after", task: "x" });
    const list = await jobTool.execute("list", { action: "list" }, undefined, undefined, ctx);
    expect(list.content[0]?.text).toBe("No subagent jobs.");
    if (oldManager) await originalShutdown.call(oldManager);
  });

  it("settles jobs before parent tree navigation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-subagent-lifecycle-"));
    temporaryDirectories.push(directory);
    const harness = createHarness();
    const startSession = harness.handlers.get("session_start")!;
    const beforeTree = harness.handlers.get("session_before_tree")!;
    const shutdownSession = harness.handlers.get("session_shutdown")!;
    const ctx = sessionContext(directory);
    await startSession({ type: "session_start" }, ctx);
    const settle = vi.spyOn(SubagentJobManager.prototype, "settle");

    await beforeTree({ type: "session_before_tree" }, ctx);
    expect(settle).toHaveBeenCalledOnce();
    await shutdownSession({ type: "session_shutdown" }, ctx);
  });

  it("restores receipts and marks unfinished jobs interrupted without retry", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-subagent-lifecycle-"));
    temporaryDirectories.push(directory);
    const harness = createHarness();
    const startSession = harness.handlers.get("session_start")!;
    const shutdownSession = harness.handlers.get("session_shutdown")!;
    const jobTool = harness.tools.get("subagent_job");
    const ctx = sessionContext(directory);
    ctx.sessionManager.appendCustomEntry("subagent-job", {
      jobId: "invalid-job",
      name: "invalid",
      task: "ignore",
      status: "invented-status",
      cwd: directory,
      createdAt: new Date(0).toISOString(),
    });
    ctx.sessionManager.appendCustomEntry("subagent-job", {
      jobId: "unfinished-job",
      name: "unfinished",
      task: "do not retry",
      status: "running",
      cwd: directory,
      createdAt: new Date(0).toISOString(),
    });

    await startSession({ type: "session_start" }, ctx);
    const status = await jobTool.execute(
      "status",
      { action: "status", job_id: "unfinished-job" },
      undefined,
      undefined,
      ctx,
    );
    expect(status.details).toMatchObject({
      jobId: "unfinished-job",
      status: "interrupted",
      restored: true,
    });
    await expect(
      jobTool.execute(
        "invalid-status",
        { action: "status", job_id: "invalid-job" },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("Unknown subagent job");
    await shutdownSession({ type: "session_shutdown" }, ctx);
  });

  it("rejects async starts during/after shutdown and creates jobs only after session_start", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-subagent-lifecycle-"));
    temporaryDirectories.push(directory);
    const harness = createHarness();
    const startSession = harness.handlers.get("session_start")!;
    const shutdownSession = harness.handlers.get("session_shutdown")!;
    const startTool = harness.tools.get("subagent_start");
    const jobTool = harness.tools.get("subagent_job");
    const ctx = sessionContext(directory);

    const beforeStart = await startTool.execute("before", { name: "before", task: "x" }, undefined, undefined, ctx);
    expect(beforeStart.details).toMatchObject({ status: "inactive", name: "before", task: "x" });

    await startSession({ type: "session_start" }, ctx);
    const shutdown = shutdownSession({ type: "session_shutdown" }, ctx);
    const duringShutdown = await startTool.execute("during", { name: "during", task: "x" }, undefined, undefined, ctx);
    expect(duringShutdown.details).toMatchObject({ status: "shutting-down" });
    await shutdown;

    const afterShutdown = await startTool.execute("after", { name: "after", task: "x" }, undefined, undefined, ctx);
    expect(afterShutdown.details).toMatchObject({ status: "inactive" });

    await startSession({ type: "session_start" }, ctx);
    const active = await startTool.execute("active", { name: "active", task: "x" }, undefined, undefined, ctx);
    expect(active.details.jobId).toEqual(expect.any(String));
    const status = await jobTool.execute(
      "status",
      { action: "status", job_id: active.details.jobId },
      undefined,
      undefined,
      ctx,
    );
    expect(status.details).toMatchObject({
      jobId: active.details.jobId,
      name: "active",
      task: "x",
    });
    await shutdownSession({ type: "session_shutdown" }, ctx);
  });
});
