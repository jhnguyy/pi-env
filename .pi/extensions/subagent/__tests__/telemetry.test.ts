import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { runSubagentEffect, type RunSubagentOptions } from "../execute";

const state = {
  output: "",
  blockUntilAbort: false,
  onStart: undefined as (() => void) | undefined,
};

const agentLoop: NonNullable<RunSubagentOptions["agentLoop"]> = (
  _prompts,
  _context,
  _config,
  signal,
) =>
  ({
    async *[Symbol.asyncIterator]() {
      if (state.blockUntilAbort) {
        await new Promise<void>((_resolve, reject) => {
          state.onStart?.();
          signal!.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          });
        });
      }
      yield {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: state.output }],
          timestamp: Date.now(),
          model: "test-model",
          stopReason: "stop",
          usage: {
            input: 11,
            output: 13,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { total: 17 },
          },
        },
      };
      yield { type: "turn_end" };
    },
    async result() {
      return [];
    },
  }) as any;

const roots: string[] = [];
afterEach(() => {
  state.output = "";
  state.blockUntilAbort = false;
  state.onStart = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function inMemoryExporter(finished: ReadableSpan[]): SpanExporter {
  return {
    export: (spans, callback) => {
      finished.push(...spans);
      callback({ code: 0 });
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  };
}

function harness(root: string) {
  const parent = SessionManager.create(root, root);
  return {
    context: {
      cwd: root,
      sessionManager: parent,
      modelRegistry: {
        find: () => ({ provider: "test-provider", id: "test-model" }),
        getApiKeyForProvider: async () => "private-api-key-sentinel",
      },
    } as any,
    tools: new Map([
      [
        "notes",
        {
          capabilities: [],
          tool: {
            name: "notes",
            label: "Notes",
            description: "",
            parameters: {},
            execute: async () => ({ content: [], details: null }),
          },
        },
      ],
    ]) as any,
  };
}

describe("subagent tooling telemetry", () => {
  it("exports fixed workflow spans without task, output, path, session, usage, or credentials", async () => {
    const root = mkdtempSync(join(tmpdir(), "subagent-secret-path-"));
    roots.push(root);
    const taskSentinel = "private-task-sentinel";
    const outputSentinel = "private-output-sentinel";
    state.output = outputSentinel;
    const finished: ReadableSpan[] = [];
    const { context, tools } = harness(root);

    const result = await Effect.runPromise(runSubagentEffect(
      {
        name: "telemetry-check",
        task: taskSentinel,
        tools: ["notes"],
        model: "test-provider/test-model",
      },
      context,
      tools,
      {
        env: {
          PI_ENV_TOOLING_OTEL_ENABLED: "true",
          PI_ENV_TOOLING_OTEL_ENDPOINT: "http://collector:4318",
        },
        telemetryExporter: inMemoryExporter(finished),
        agentLoop,
      },
    ));

    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toBe(outputSentinel);
    expect(finished.map((span) => span.name)).toEqual(
      expect.arrayContaining([
        "tooling.subagent.resolve",
        "tooling.subagent.session",
        "tooling.subagent.agent_loop",
        "tooling.subagent.run",
      ]),
    );

    const run = finished.find((span) => span.name === "tooling.subagent.run");
    expect(run?.attributes).toMatchObject({
      operation: "run",
      mode: "sync",
      outcome: "success",
      tool_count: 1,
      provider: "test-provider",
      model: "test-model",
    });

    const exported = JSON.stringify(
      finished.map((span) => ({
        name: span.name,
        attributes: span.attributes,
        events: span.events,
        status: span.status,
      })),
    );
    for (const sentinel of [
      root,
      taskSentinel,
      outputSentinel,
      "private-api-key-sentinel",
      "11",
      "13",
      "17",
    ]) {
      expect(exported).not.toContain(sentinel);
    }
  });

  it("returns the existing error-shaped result when caller cancellation reaches agentLoop", async () => {
    const root = mkdtempSync(join(tmpdir(), "subagent-cancel-"));
    roots.push(root);
    state.blockUntilAbort = true;
    let started!: () => void;
    const agentLoopStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    state.onStart = started;
    const controller = new AbortController();
    const { context, tools } = harness(root);

    const pending = Effect.runPromise(runSubagentEffect(
      {
        name: "cancel-check",
        task: "wait until cancelled",
        tools: ["notes"],
        model: "test-provider/test-model",
      },
      context,
      tools,
      { env: {}, signal: controller.signal, agentLoop },
    ));
    await agentLoopStarted;
    controller.abort();
    const result = await pending;

    expect(result.details).toMatchObject({ isError: true, stopReason: "aborted" });
  });

  it("emits no spans when telemetry is disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "subagent-disabled-"));
    roots.push(root);
    state.output = "ordinary output";
    const finished: ReadableSpan[] = [];
    const { context, tools } = harness(root);

    await Effect.runPromise(runSubagentEffect(
      {
        name: "disabled-check",
        task: "ordinary task",
        tools: ["notes"],
        model: "test-provider/test-model",
      },
      context,
      tools,
      { env: {}, telemetryExporter: inMemoryExporter(finished), agentLoop },
    ));

    expect(finished).toEqual([]);
  });
});
