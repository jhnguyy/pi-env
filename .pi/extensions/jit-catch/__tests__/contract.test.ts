import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

import { AgentToolEvent, PiEvent, ToolCapability, type ExtToolRegistration } from "../../_shared/agent-tools";
import { resetAgentToolRegistryForTests } from "../../_shared/agent-tool-registry";
import { err } from "../../_shared/result";
import jitCatchExtension from "../index";
import { createJitCatchContract, executeJitCatchEffect, JIT_CATCH_DESCRIPTION, JIT_CATCH_PARAMETERS } from "../contract";
import * as runner from "../runner";

const runnerState = vi.hoisted(() => ({
  runResult: { extName: "demo", passed: true, testOutput: "ok" } as any,
  runCalls: [] as any[],
  runEffect: null as any,
}));

vi.mock("../runner", async () => {
  const actual = await vi.importActual<typeof import("../runner")>("../runner");
  return {
    ...actual,
    resolveGitRoot: vi.fn(async (_exec, cwd: string) => `${cwd}/root`),
    resolveGitRootEffect: vi.fn((_exec, cwd: string) => Effect.succeed(`${cwd}/root`)),
    captureDiff: vi.fn(async (_source, _exec, _cwd: string) => [
      "diff --git a/.pi/extensions/demo/index.ts b/.pi/extensions/demo/index.ts",
      "+++ b/.pi/extensions/demo/index.ts",
      "diff --git a/README.md b/README.md",
      "+++ b/README.md",
    ].join("\n")),
    captureDiffEffect: vi.fn((_source, _exec, _cwd: string) => Effect.succeed([
      "diff --git a/.pi/extensions/demo/index.ts b/.pi/extensions/demo/index.ts",
      "+++ b/.pi/extensions/demo/index.ts",
      "diff --git a/README.md b/README.md",
      "+++ b/README.md",
    ].join("\n"))),
    runForExtension: vi.fn(async (...args: any[]) => {
      runnerState.runCalls.push(args);
      args[5]?.("running tests…");
      return runnerState.runResult;
    }),
    runForExtensionEffect: vi.fn((...args: any[]) => {
      runnerState.runCalls.push(args);
      if (runnerState.runEffect) return runnerState.runEffect;
      return Effect.sync(() => {
        args[4]?.("running tests…");
        return runnerState.runResult;
      });
    }),
    phaseErrorToRunResult: vi.fn((ext: any, error: any) => ({
      extName: ext.name,
      passed: false,
      testOutput: String(error),
      testPath: null,
    })),
  };
});

function createPi() {
  const tools: any[] = [];
  const registrations: ExtToolRegistration[] = [];
  const sessionHandlers: Array<(event: unknown, ctx: ExtensionContext) => void> = [];
  const execCwds: string[] = [];
  return {
    tools,
    registrations,
    execCwds,
    pi: {
      exec: async (_cmd: string, _args: string[], opts?: { cwd?: string }) => {
        execCwds.push(opts?.cwd ?? "");
        return { code: 0, stdout: "", stderr: "" };
      },
      registerTool(tool: any) {
        tools.push(tool);
      },
      events: {
        emit(event: typeof AgentToolEvent.Register, data: ExtToolRegistration) {
          if (event === AgentToolEvent.Register) registrations.push(data);
        },
      },
      on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
        if (event === PiEvent.SessionStart) sessionHandlers.push(handler);
      },
    },
    startSession(cwd: string) {
      for (const handler of sessionHandlers) handler({ type: PiEvent.SessionStart, reason: "startup" }, { cwd } as ExtensionContext);
    },
  };
}

describe("jit_catch tool contract", () => {
  beforeEach(() => {
    resetAgentToolRegistryForTests();
    runnerState.runResult = { extName: "demo", passed: true, testOutput: "ok" };
    runnerState.runCalls = [];
    runnerState.runEffect = null;
    vi.clearAllMocks();
  });

  it("uses one schema and description across Pi and AgentTool registration", () => {
    const harness = createPi();
    jitCatchExtension(harness.pi as any);
    harness.startSession("/agent/session");

    expect(harness.tools[0].parameters).toBe(JIT_CATCH_PARAMETERS);
    expect(harness.tools[0].description).toBe(JIT_CATCH_DESCRIPTION);
    expect(harness.registrations[0].tool.parameters).toBe(JIT_CATCH_PARAMETERS);
    expect(harness.registrations[0].tool.description).toBe(harness.tools[0].description);
  });

  it("preserves jit_catch capabilities", () => {
    const harness = createPi();
    jitCatchExtension(harness.pi as any);
    harness.startSession("/agent/session");

    expect(harness.registrations[0].capabilities).toEqual([
      ToolCapability.Write,
      ToolCapability.Execute,
    ]);
  });

  it("uses Pi cwd per invocation and captured Agent session cwd", async () => {
    const harness = createPi();
    jitCatchExtension(harness.pi as any);
    harness.startSession("/agent/session");

    await harness.tools[0].execute("pi", {}, undefined, undefined, { cwd: "/pi/context" });
    await harness.registrations[0].tool.execute("agent", {}, undefined);

    expect(runnerState.runCalls.map((call) => call[3])).toEqual(["/pi/context/root", "/agent/session/root"]);
  });

  it("keeps each AgentTool bound to the session that registered it", async () => {
    const harness = createPi();
    jitCatchExtension(harness.pi as any);
    harness.startSession("/session/one");
    const firstSessionTool = harness.registrations[0].tool;
    harness.startSession("/session/two");
    const secondSessionTool = harness.registrations[1].tool;

    await firstSessionTool.execute("first", {}, undefined);
    await secondSessionTool.execute("second", {}, undefined);

    expect(runnerState.runCalls.map((call) => call[3])).toEqual(["/session/one/root", "/session/two/root"]);
  });

  it("lets explicit git_cwd override adapter cwd", async () => {
    const harness = createPi();
    jitCatchExtension(harness.pi as any);
    harness.startSession("/agent/session");

    await harness.tools[0].execute("pi", { git_cwd: "/explicit" }, undefined, undefined, { cwd: "/pi/context" });
    await harness.registrations[0].tool.execute("agent", { git_cwd: "/explicit" }, undefined);

    expect(runnerState.runCalls.map((call) => call[3])).toEqual(["/explicit/root", "/explicit/root"]);
  });

  it("preserves matching progress shape through both adapters", async () => {
    const harness = createPi();
    jitCatchExtension(harness.pi as any);
    harness.startSession("/agent/session");
    const signal = new AbortController().signal;
    const piUpdates: unknown[] = [];
    const agentUpdates: unknown[] = [];

    await harness.tools[0].execute("pi", {}, signal, (update: unknown) => piUpdates.push(update), { cwd: "/pi/context" });
    await harness.registrations[0].tool.execute("agent", {}, signal, (update: unknown) => agentUpdates.push(update));

    expect(piUpdates).toContainEqual({ content: [{ type: "text", text: "demo: running tests…" }], details: { phase: "demo: running tests…" } });
    expect(agentUpdates).toContainEqual({ content: [{ type: "text", text: "demo: running tests…" }], details: { phase: "demo: running tests…" } });
  });

  it("interrupts contract execution through the single Effect.runPromise signal adapter", async () => {
    runnerState.runEffect = Effect.never;
    const harness = createPi();
    const contract = createJitCatchContract(harness.pi.exec as any);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 0);

    await expect(contract.execute({}, { cwd: "/cancel", signal: controller.signal })).rejects.toBeDefined();
    expect(runnerState.runCalls).toHaveLength(1);
  });

  it("exposes an Effect-native execution seam without using Promise runner wrappers", async () => {
    const harness = createPi();
    const result = await Effect.runPromise(executeJitCatchEffect({}, harness.pi.exec as any, { cwd: "/effect" }));

    expect(result.details).toEqual({
      results: [{ extName: "demo", passed: true, testOutput: "ok" }],
      anyFailed: false,
    });
    expect(runner.resolveGitRoot).not.toHaveBeenCalled();
    expect(runner.captureDiff).not.toHaveBeenCalled();
    expect(runner.runForExtension).not.toHaveBeenCalled();
  });

  it("returns operational acquisition throws with phase/command/cause details", async () => {
    vi.mocked(runner.captureDiffEffect).mockReturnValueOnce(Effect.fail(new runner.ExecPhaseError({
      phase: "capture diff",
      command: "git diff",
      cause: new Error("spawn ENOENT"),
    })));

    const result = await Effect.runPromise(executeJitCatchEffect({}, createPi().pi.exec as any, { cwd: "/same" }));

    expect(result).toEqual(err("Operational subprocess failure during capture diff: git diff: spawn ENOENT"));
  });

  it("returns equivalent final result/details for the same domain scenario", async () => {
    runnerState.runResult = { extName: "demo", passed: false, testPath: "/tmp/demo.catching.test.ts", testOutput: "line1\nline2" };
    const harness = createPi();
    jitCatchExtension(harness.pi as any);
    harness.startSession("/agent/session");

    const piResult = await harness.tools[0].execute("pi", {}, undefined, undefined, { cwd: "/same" });
    const agentResult = await harness.registrations[0].tool.execute("agent", {}, undefined);
    const contractResult = await createJitCatchContract(harness.pi.exec as any).execute({}, { cwd: "/same" });

    expect(piResult.content[0].text).toContain("Note: diff also contains non-extension files (ignored).\n");
    expect(piResult.content[0].text).toContain("✗ demo — tests FAILED.");
    expect(piResult.content[0].text).toContain("  Test file kept at: /tmp/demo.catching.test.ts");
    expect(piResult.content[0].text).toContain("  Output:\n  line1\n  line2");
    expect(piResult.details).toEqual(contractResult.details);
    expect(agentResult.details).toEqual(piResult.details);
  });
});
