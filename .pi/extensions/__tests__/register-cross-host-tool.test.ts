import { beforeEach, describe, expect, it } from "vitest";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import {
  AgentToolEvent,
  PiEvent,
  ToolCapability,
  listenForAgentTools,
  resetAgentToolRegistryForTests,
  type AgentToolEvents,
  type ExtToolRegistration,
} from "../_shared/agent-tools";
import type { ToolContract } from "../_shared/tool-contract";
import { registerCrossHostTool } from "../_shared/register-cross-host-tool";

const PARAMETERS = Type.Object({ value: Type.String() });
type Params = Static<typeof PARAMETERS>;
type Details = { cwd: string };
const PI_OPTIONS = {
  renderCall: () => ({ kind: "call" }) as any,
  renderResult: () => ({ kind: "result" }) as any,
};

function createContract(seen: Array<{ cwd: string; signal?: AbortSignal }>): ToolContract<Params, Details, typeof PARAMETERS> {
  return {
    name: "cross_host_sample",
    label: "Cross Host Sample",
    description: "Shared cross-host contract",
    parameters: PARAMETERS,
    async execute(_params, context) {
      seen.push({ cwd: context.cwd, signal: context.signal });
      context.progress?.(`cwd:${context.cwd}`);
      return { content: [{ type: "text", text: context.cwd }], details: { cwd: context.cwd } };
    },
  };
}

function createPiHarness() {
  const tools: ToolDefinition<any, any, any>[] = [];
  const registrations: ExtToolRegistration[] = [];
  const listeners = new Map<string, Array<(...args: any[]) => void>>();

  const pi: AgentToolEvents & {
    registerTool: (tool: ToolDefinition<any, any, any>) => void;
    trigger: (event: string, ...args: any[]) => void;
  } = {
    registerTool(tool) {
      tools.push(tool);
    },
    events: {
      emit(event, data) {
        if (event === AgentToolEvent.Register) registrations.push(data);
        if (event === AgentToolEvent.Unregister) {
          const index = registrations.indexOf(data);
          if (index >= 0) registrations.splice(index, 1);
        }
        for (const handler of listeners.get(event) ?? []) handler(data);
      },
      on(event, handler) {
        const current = listeners.get(event) ?? [];
        current.push(handler as (...args: any[]) => void);
        listeners.set(event, current);
        return () => listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== handler));
      },
    },
    on(event, handler) {
      const current = listeners.get(event) ?? [];
      current.push(handler);
      listeners.set(event, current);
    },
    trigger(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args);
    },
  };

  return { pi, tools, registrations };
}

describe("registerCrossHostTool contract", () => {
  beforeEach(() => {
    resetAgentToolRegistryForTests();
  });

  it("requires non-empty capability classification and preserves it", () => {
    const harness = createPiHarness();
    registerCrossHostTool(harness.pi as any, {
      contract: createContract([]),
      capabilities: [ToolCapability.Write, ToolCapability.Execute],
      piOptions: PI_OPTIONS,
    });

    harness.pi.trigger(PiEvent.SessionStart, { type: PiEvent.SessionStart }, { cwd: "/main" });

    expect(harness.registrations[0]?.capabilities).toEqual([ToolCapability.Write, ToolCapability.Execute]);
  });

  it("passes Pi-only prompt and render metadata to Pi registration", () => {
    const harness = createPiHarness();
    const promptSnippet = "snippet";
    const promptGuidelines = ["guidelines"];
    const renderCall = () => ({ kind: "call" }) as any;
    const renderResult = () => ({ kind: "result" }) as any;

    registerCrossHostTool(harness.pi as any, {
      contract: createContract([]),
      capabilities: [ToolCapability.Read],
      piOptions: { promptSnippet, promptGuidelines, renderCall, renderResult },
    });

    expect(harness.tools[0]?.promptSnippet).toBe(promptSnippet);
    expect(harness.tools[0]?.promptGuidelines).toBe(promptGuidelines);
    expect(harness.tools[0]?.renderCall).toBe(renderCall);
    expect(harness.tools[0]?.renderResult).toBe(renderResult);
  });

  it("registers AgentTool at session start and unregisters it at session shutdown", () => {
    const harness = createPiHarness();
    const added: string[] = [];
    const removed: string[] = [];
    listenForAgentTools(harness.pi, (entry) => added.push(entry.tool.name), (entry) => removed.push(entry.tool.name));

    registerCrossHostTool(harness.pi as any, {
      contract: createContract([]),
      capabilities: [ToolCapability.Read],
      piOptions: PI_OPTIONS,
    });

    expect(added).toEqual([]);
    harness.pi.trigger(PiEvent.SessionStart, { type: PiEvent.SessionStart }, { cwd: "/main" });
    expect(added).toEqual(["cross_host_sample"]);
    harness.pi.trigger(PiEvent.SessionShutdown, { type: PiEvent.SessionShutdown });
    expect(removed).toEqual(["cross_host_sample"]);
  });

  it("uses the parent context when a child tool has one", async () => {
    const seen: Array<{ cwd: string; signal?: AbortSignal }> = [];
    const harness = createPiHarness();
    registerCrossHostTool(harness.pi as any, {
      contract: createContract(seen),
      capabilities: [ToolCapability.Read],
      piOptions: PI_OPTIONS,
    });
    harness.pi.trigger(PiEvent.SessionStart, { type: PiEvent.SessionStart }, { cwd: "/main" });
    const createTool = harness.registrations[0].createTool!;

    await createTool({ cwd: "/child", sessionGeneration: "g1" }).execute("child", { value: "x" }, undefined);
    await createTool({ cwd: "/child", parentContext: { cwd: "/parent" } as ExtensionContext, sessionGeneration: "g1" }).execute("child", { value: "x" }, undefined);

    expect(seen.map((entry) => entry.cwd)).toEqual(["/child", "/parent"]);
  });

  it("uses main-session cwd for the main AgentTool and child cwd for child tools without parent context", async () => {
    const seen: Array<{ cwd: string; signal?: AbortSignal }> = [];
    const harness = createPiHarness();
    registerCrossHostTool(harness.pi as any, {
      contract: createContract(seen),
      capabilities: [ToolCapability.Read],
      piOptions: PI_OPTIONS,
    });

    harness.pi.trigger(PiEvent.SessionStart, { type: PiEvent.SessionStart }, { cwd: "/main-session" });

    const active = harness.registrations[0];
    await active.tool.execute("main", { value: "x" }, undefined);
    await active.createTool!({
      cwd: "/child-session",
      sessionGeneration: active.sessionGeneration!,
    }).execute("child", { value: "x" }, undefined);

    expect(seen.map((entry) => entry.cwd)).toEqual(["/main-session", "/child-session"]);
  });

  it("forwards cancellation signal and progress in both adapters", async () => {
    const seen: Array<{ cwd: string; signal?: AbortSignal }> = [];
    const harness = createPiHarness();
    const signal = new AbortController().signal;
    const piUpdates: AgentToolResult<unknown>[] = [];
    const agentUpdates: AgentToolResult<unknown>[] = [];
    registerCrossHostTool(harness.pi as any, {
      contract: createContract(seen),
      capabilities: [ToolCapability.Read],
      piOptions: PI_OPTIONS,
    });

    harness.pi.trigger(PiEvent.SessionStart, { type: PiEvent.SessionStart }, { cwd: "/agent" });

    await harness.tools[0].execute("pi", { value: "p" }, signal, (update) => piUpdates.push(update as AgentToolResult<unknown>), { cwd: "/pi" } as ExtensionContext);
    await harness.registrations[0].tool.execute("agent", { value: "a" }, signal, (update) => agentUpdates.push(update));

    expect(seen.map((entry) => entry.signal)).toEqual([signal, signal]);
    expect(piUpdates).toEqual([{ content: [{ type: "text", text: "cwd:/pi" }], details: { phase: "cwd:/pi" } }]);
    expect(agentUpdates).toEqual([{ content: [{ type: "text", text: "cwd:/agent" }], details: { phase: "cwd:/agent" } }]);
  });
});
