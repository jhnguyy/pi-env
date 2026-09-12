import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

import {
  AgentToolEvent,
  PiEvent,
  ToolCapability,
  resetAgentToolRegistryForTests,
  type ExtToolRegistration,
} from "../../_shared/agent-tools";
import { err } from "../../_shared/result";
import { createJitCatchExtension } from "../index";
import { ProcessFailure, ProcessFailureKind } from "../../../../src/process/platform.js";
import {
  createJitCatchContractWithRunner,
  type JitCatchOperations,
} from "../contract";
import {
  ExecPhaseError,
  phaseErrorToRunResult,
  type JitCatchPhaseError,
  type JitRunner,
} from "../runner";
import type { ExtensionRunResult } from "../types";

const diff = [
  "diff --git a/.pi/extensions/demo/index.ts b/.pi/extensions/demo/index.ts",
  "+++ b/.pi/extensions/demo/index.ts",
  "diff --git a/README.md b/README.md",
  "+++ b/README.md",
].join("\n");

type RunCall = Parameters<JitCatchOperations["runForExtension"]>;

const runnerState: {
  runResult: ExtensionRunResult;
  runCalls: RunCall[];
  runEffect: Effect.Effect<ExtensionRunResult, JitCatchPhaseError> | null;
} = {
  runResult: { extName: "demo", passed: true, testOutput: "ok", testPath: null },
  runCalls: [],
  runEffect: null,
};

const testRunner: JitRunner = () => Effect.succeed({ code: 0, stdout: "", stderr: "" });
const testOperations: JitCatchOperations = {
  resolveGitRoot: (_runner, cwd) => Effect.succeed(`${cwd}/root`),
  captureDiff: () => Effect.succeed(diff),
  runForExtension: (...args) => {
    runnerState.runCalls.push(args);
    if (runnerState.runEffect) return runnerState.runEffect;
    return Effect.sync(() => {
      args[4]?.("running tests…");
      return runnerState.runResult;
    });
  },
  phaseErrorToRunResult,
};
const jitCatchExtension = createJitCatchExtension(testRunner, testOperations);

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
      for (const handler of sessionHandlers)
        handler({ type: PiEvent.SessionStart, reason: "startup" }, { cwd } as ExtensionContext);
    },
  };
}

describe("jit_catch tool contract", () => {
  beforeEach(() => {
    resetAgentToolRegistryForTests();
    runnerState.runResult = { extName: "demo", passed: true, testOutput: "ok", testPath: null };
    runnerState.runCalls = [];
    runnerState.runEffect = null;
  });

  it("registers write and execute authority", () => {
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

    expect(runnerState.runCalls.map((call) => call[3])).toEqual([
      "/pi/context/root",
      "/agent/session/root",
    ]);
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

    expect(runnerState.runCalls.map((call) => call[3])).toEqual([
      "/session/one/root",
      "/session/two/root",
    ]);
  });

  it("lets explicit git_cwd override adapter cwd", async () => {
    const harness = createPi();
    jitCatchExtension(harness.pi as any);
    harness.startSession("/agent/session");

    await harness.tools[0].execute("pi", { git_cwd: "/explicit" }, undefined, undefined, {
      cwd: "/pi/context",
    });
    await harness.registrations[0].tool.execute("agent", { git_cwd: "/explicit" }, undefined);

    expect(runnerState.runCalls.map((call) => call[3])).toEqual([
      "/explicit/root",
      "/explicit/root",
    ]);
  });

  it("preserves matching progress shape through both adapters", async () => {
    const harness = createPi();
    jitCatchExtension(harness.pi as any);
    harness.startSession("/agent/session");
    const signal = new AbortController().signal;
    const piUpdates: unknown[] = [];
    const agentUpdates: unknown[] = [];

    await harness.tools[0].execute("pi", {}, signal, (update: unknown) => piUpdates.push(update), {
      cwd: "/pi/context",
    });
    await harness.registrations[0].tool.execute("agent", {}, signal, (update: unknown) =>
      agentUpdates.push(update),
    );

    expect(piUpdates).toContainEqual({
      content: [{ type: "text", text: "demo: running tests…" }],
      details: { phase: "demo: running tests…" },
    });
    expect(agentUpdates).toContainEqual({
      content: [{ type: "text", text: "demo: running tests…" }],
      details: { phase: "demo: running tests…" },
    });
  });

  it("interrupts contract execution through the single Effect.runPromise signal adapter", async () => {
    runnerState.runEffect = Effect.never;
    const contract = createJitCatchContractWithRunner(() => Effect.never, testOperations);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 0);

    await expect(
      contract.execute({}, { cwd: "/cancel", signal: controller.signal }),
    ).rejects.toBeDefined();
    expect(runnerState.runCalls).toHaveLength(1);
  });

  it("returns operational acquisition throws with phase/command/cause details", async () => {
    const acquisitionFailure = new ExecPhaseError({
      phase: "capture diff",
      command: "git diff",
      cause: new ProcessFailure({
        kind: ProcessFailureKind.Spawn,
        command: "git diff",
        message: "spawn ENOENT",
      }),
    });
    const failingOperations: JitCatchOperations = {
      ...testOperations,
      captureDiff: () => Effect.fail(acquisitionFailure),
    };

    const result = await createJitCatchContractWithRunner(
      testRunner,
      failingOperations,
    ).execute({}, { cwd: "/same" });

    expect(result).toEqual(
      err("Operational subprocess failure during capture diff: git diff: spawn ENOENT"),
    );
  });

  it("formats the final failure result", async () => {
    runnerState.runResult = {
      extName: "demo",
      passed: false,
      testPath: "/tmp/demo.catching.test.ts",
      testOutput: "line1\nline2",
    };
    const harness = createPi();
    jitCatchExtension(harness.pi as any);
    harness.startSession("/agent/session");

    const piResult = await harness.tools[0].execute("pi", {}, undefined, undefined, {
      cwd: "/same",
    });
    expect(piResult.content[0].text).toContain("✗ demo — tests FAILED.");
    expect(piResult.content[0].text).toContain("  Test file kept at: /tmp/demo.catching.test.ts");
    expect(piResult.content[0].text).toContain("  Output:\n  line1\n  line2");
  });
});
