import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createSubagentHarness } from "./harness";

// Admission and accepted-work survival belong to registered-native and the
// service multiprocess workflow. These checks never connect or invoke a model.
describe("subagent extension inactive lifecycle", () => {
  it("rejects starts before activation, during shutdown, and after shutdown", async () => {
    const harness = createSubagentHarness();
    const subagent = harness.tools.get("subagent")!;
    const ctx = {
      cwd: "/tmp",
      sessionManager: SessionManager.inMemory("/tmp"),
      modelRegistry: { getAvailable: () => [] },
      scopedModels: [],
    } as any;
    const start = () => subagent.execute("start", { action: "start", name: "audit", task: "x" }, undefined, undefined, ctx);

    await expect(start()).rejects.toThrow("Parent subagent session is not active.");
    const shutdown = harness.handlers.get("session_shutdown")!({}, ctx);
    await expect(start()).rejects.toThrow("Parent subagent session is not active.");
    await shutdown;
    await expect(start()).rejects.toThrow("Parent subagent session is not active.");
    const list = await subagent.execute("list", { action: "list" }, undefined, undefined, ctx);
    expect(list.content[0]?.text).toBe("No subagent jobs.");
  });
});
