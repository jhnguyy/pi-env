import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { createSubagentHarness } from "./harness";
import { settleOperations, testCleanup } from "./cleanup";
import { SubagentJobManager } from "../jobs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-subagent-lifecycle-"));
  const cleanup = testCleanup();
  cleanup(() => rmSync(directory, { recursive: true, force: true }));
  cleanup(() => vi.restoreAllMocks());
  const harness = createSubagentHarness();
  const ctx = sessionContext(directory);
  cleanup(() => harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx));
  return { harness, ctx, cleanup };
}

function sessionContext(cwd: string) {
  return {
    cwd,
    sessionManager: SessionManager.inMemory(cwd),
    modelRegistry: {
      getAvailable: () => [],
    },
    scopedModels: [],
  } as any;
}

describe("subagent extension session lifecycle", () => {
  it("does not let a stale session_start reactivate after a newer shutdown", async () => {
    const { harness, ctx, cleanup } = fixture();
    const startSession = harness.handlers.get("session_start")!;
    const shutdownSession = harness.handlers.get("session_shutdown")!;
    const subagent = harness.tools.get("subagent");
    await startSession({ type: "session_start" }, ctx);

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let oldManager: SubagentJobManager | undefined;
    const originalShutdown = SubagentJobManager.prototype.shutdown;
    vi.spyOn(SubagentJobManager.prototype, "shutdown").mockImplementationOnce(
      function (this: SubagentJobManager) {
        oldManager = this;
        return blocked;
      },
    );

    const operations: Promise<unknown>[] = [];
    cleanup(() => release(), () => settleOperations(operations), () => oldManager && originalShutdown.call(oldManager));
    const staleStart = startSession({ type: "session_start" }, ctx);
    operations.push(staleStart);
    await Promise.resolve();
    let shutdownSettled = false;
    const shutdown = shutdownSession({ type: "session_shutdown" }, ctx).then(() => {
      shutdownSettled = true;
    });
    operations.push(shutdown);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(shutdownSettled).toBe(false);
    release();
    await Promise.all([staleStart, shutdown]);

    const result = await subagent.execute(
      "after",
      { action: "start", name: "after", task: "x" },
      undefined,
      undefined,
      ctx,
    );
    expect(result.details).toMatchObject({ status: "inactive", name: "after", task: "x" });
    const list = await subagent.execute("list", { action: "list" }, undefined, undefined, ctx);
    expect(list.content[0]?.text).toBe("No subagent jobs.");
  });

  it("rejects async starts during/after shutdown and creates jobs only after session_start", async () => {
    const { harness, ctx } = fixture();
    const startSession = harness.handlers.get("session_start")!;
    const shutdownSession = harness.handlers.get("session_shutdown")!;
    const subagent = harness.tools.get("subagent");

    const beforeStart = await subagent.execute(
      "before",
      { action: "start", name: "before", task: "x" },
      undefined,
      undefined,
      ctx,
    );
    expect(beforeStart.details).toMatchObject({ status: "inactive", name: "before", task: "x" });

    await startSession({ type: "session_start" }, ctx);
    const shutdown = shutdownSession({ type: "session_shutdown" }, ctx);
    const duringShutdown = await subagent.execute(
      "during",
      { action: "start", name: "during", task: "x" },
      undefined,
      undefined,
      ctx,
    );
    expect(duringShutdown.details).toMatchObject({ status: "shutting-down" });
    await shutdown;

    const afterShutdown = await subagent.execute(
      "after",
      { action: "start", name: "after", task: "x" },
      undefined,
      undefined,
      ctx,
    );
    expect(afterShutdown.details).toMatchObject({ status: "inactive" });

    await startSession({ type: "session_start" }, ctx);
    const active = await subagent.execute(
      "active",
      { action: "start", name: "active", task: "x" },
      undefined,
      undefined,
      ctx,
    );
    expect(active.details.jobId).toEqual(expect.any(String));
    const status = await subagent.execute(
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
