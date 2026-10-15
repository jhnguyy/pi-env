import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  DagExecutorKind,
  buildDagSubagentPrompt,
  parseDagSubagentPayload,
  type DagSubagentRuntimeRequest,
} from "../../../../src/dag/index.js";

const shared = {
  calls: [] as any[],
  result: {
    details: {
      finalOutput: "complete result",
      isError: false,
      turnLimitExceeded: false,
    },
  } as any,
};

import * as DagRuntime from "../dag-runtime";

const roots: string[] = [];
afterEach(() => {
  shared.calls.length = 0;
  shared.result = {
    details: { finalOutput: "complete result", isError: false, turnLimitExceeded: false },
  };
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "pi-dag-subagent-runtime-"));
  roots.push(value);
  return value;
}

function context(cwd: string, model: unknown, trusted = true): any {
  return {
    cwd,
    isProjectTrusted: () => trusted,
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === "test" && id === "model" ? model : undefined,
      getAvailable: () => [model],
    },
  };
}

function request(cwd: string, overrides: Record<string, unknown> = {}): DagSubagentRuntimeRequest {
  const payload = parseDagSubagentPayload({
    v: 1,
    name: "child",
    instructions: "Do the task.",
    model: "test/model",
    tools: [],
    workspace: { cwd, access: "read" },
    context: { outputs: [] },
    output: { name: "answer" },
    ...overrides,
  });
  return {
    runId: "run",
    nodeId: "node",
    attemptId: "run:node:1",
    payload,
    prompt: buildDagSubagentPrompt(payload, { outputs: [], bytes: 0 }),
  };
}

async function failure(effect: Effect.Effect<string, unknown>): Promise<any> {
  return Effect.runPromise(Effect.flip(effect));
}

const executeResolved: NonNullable<
  Parameters<typeof DagRuntime.makeDagSubagentRuntime>[1]["executeResolved"]
> = (run, _ctx, options) => {
  shared.calls.push({ run, options });
  return Effect.succeed(shared.result);
};

// Native dispatch, model/empty selection and one-request results are
// exercised by review/__tests__/native-dag.integration.test.ts.
function adapter(ctx: any) {
  return DagRuntime.makeDagSubagentRuntime(ctx, { executeResolved });
}

describe("DAG shared subagent runtime adapter", () => {
  it("rejects a cwd outside the parent workspace", async () => {
    const parent = root();
    const outside = root();
    const runtime = adapter(
      context(parent, { provider: "test", id: "model", contextWindow: 32_000 }),
    );

    expect((await failure(runtime.run(request(outside)))).phase).toBe("resolution");
    expect(shared.calls).toHaveLength(0);
  });

  it("uses a run-scoped workspace authority outside the parent checkout", async () => {
    const parent = root();
    const managed = root();
    const outside = root();
    const ctx = context(parent, { provider: "test", id: "model", contextWindow: 32_000 });
    const runtime = DagRuntime.makeDagSubagentRuntime(ctx, {
      workspaceRootForRun: (runId) => (runId === "run" ? managed : undefined),
      executeResolved,
    });

    await expect(Effect.runPromise(runtime.run(request(managed)))).resolves.toBe("complete result");
    expect((await failure(runtime.run(request(outside)))).phase).toBe("resolution");
  });

  it("registers only the versioned subagent executor key", async () => {
    const cwd = root();
    const ctx = context(cwd, { provider: "test", id: "model", contextWindow: 32_000 });
    const registry = DagRuntime.createDagSubagentExecutorRegistry(ctx, cwd, "generation", {});

    await expect(
      Effect.runPromise(registry.lookup(DagExecutorKind.Subagent, DagRuntime.DagSubagentExecutorKey)),
    ).resolves.toBeTypeOf("function");
    await expect(
      Effect.runPromise(registry.lookup(DagExecutorKind.Subagent, "other")),
    ).resolves.toBeUndefined();
  });

  it("converts child error and turn-limit results to execution failures", async () => {
    const cwd = root();
    const runtime = adapter(context(cwd, { provider: "test", id: "model", contextWindow: 32_000 }));
    shared.result = {
      details: { finalOutput: "partial", isError: true, turnLimitExceeded: false },
    };
    expect((await failure(runtime.run(request(cwd)))).phase).toBe("execution");
    shared.result = {
      details: { finalOutput: "partial", isError: false, turnLimitExceeded: true },
    };
    expect((await failure(runtime.run(request(cwd)))).phase).toBe("execution");
  });
});
