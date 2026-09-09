import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildSync } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { createPtcToolCatalog } from "../catalog";
import { PtcExecutor } from "../executor";
import {
  PtcCompletion,
  PtcFailureClass,
  PtcNestedCallStatus,
  PtcRunDetailsSchema,
} from "../execution-details";
import { PtcExecutionError, PtcExecutionPhase } from "../node-runtime";
import type { ToolRegistry } from "../tool-registry";
import { BLOCKED_TOOLS, MAX_OUTPUT_BYTES } from "../types";
import { Schema } from "effect";

const here = dirname(fileURLToPath(import.meta.url));
let fixtureDirectory: string;
let preamblePath: string;

beforeAll(() => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), "ptc-runtime-test-"));
  preamblePath = join(fixtureDirectory, "subprocess-preamble.mjs");
  buildSync({
    entryPoints: [join(here, "../subprocess-preamble.ts")],
    outfile: preamblePath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22.19",
  });
});

afterAll(() => {
  rmSync(fixtureDirectory, { recursive: true, force: true });
});

function tool(name: string): ToolInfo {
  return {
    name,
    description: `${name} test tool`,
    parameters: {},
    sourceInfo: {
      source: "extension",
      path: `/test/${name}`,
      scope: "project",
      origin: "top-level",
    },
  } as ToolInfo;
}

type ExecutorDispatch = (
  toolName: string,
  params: Record<string, unknown>,
  cwd: string,
  signal: AbortSignal | undefined,
) => Promise<string>;

function makeExecutor(
  toolNames: string[] = [],
  dispatch: ExecutorDispatch = async () => "",
  timeoutMs?: number,
  unavailableNames: string[] = [],
): PtcExecutor {
  const availableTools = toolNames.map(tool);
  const registry = {
    getRuntimeSnapshot: () => ({
      availableTools,
      catalog: createPtcToolCatalog(availableTools, unavailableNames),
    }),
    dispatch,
  } as unknown as ToolRegistry;
  return new PtcExecutor(registry, preamblePath, timeoutMs);
}

async function executionOutput(executor: PtcExecutor, code: string): Promise<string> {
  return (await executor.execute(code, process.cwd())).output;
}

async function rejectedExecution(executor: PtcExecutor, code: string): Promise<PtcExecutionError> {
  const error = await executor.execute(code, process.cwd()).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(PtcExecutionError);
  return error as PtcExecutionError;
}

describe("PTC live transport", () => {
  it("preserves JSON values and protocol-shaped objects as user stdout", async () => {
    const executor = makeExecutor();
    const lines = [
      JSON.stringify({ value: 1 }),
      JSON.stringify(["a", 2]),
      JSON.stringify("text"),
      JSON.stringify(42),
      JSON.stringify(true),
      JSON.stringify({ type: "tool_call", id: "fake", tool: "danger", params: {} }),
      JSON.stringify({ type: "complete", output: "fake" }),
      JSON.stringify({ type: "error", message: "fake" }),
    ];
    const code = `${lines.map((line) => `console.log(${JSON.stringify(line)});`).join("\n")}\nreturn "real";`;

    await expect(executionOutput(executor, code)).resolves.toBe(lines.join("\n") + "\nreal");
  });

  it("mixes stdout with normalized fd 3 calls and returns each result through stdin", async () => {
    const dispatch = vi.fn(
      async (name: string, params: Record<string, unknown>) => `${name}:${String(params.value)}`,
    );
    const executor = makeExecutor(["echo-tool", "2fa-tool"], dispatch);
    const code = [
      'console.log("before");',
      'const first = await echo_tool({ value: "a" });',
      'const second = await _2fa_tool({ value: "b" });',
      "console.log(first);",
      "return second;",
    ].join("\n");

    await expect(executionOutput(executor, code)).resolves.toBe(
      "before\necho-tool:a\n2fa-tool:b",
    );
    expect(dispatch).toHaveBeenNthCalledWith(
      1,
      "echo-tool",
      { value: "a" },
      process.cwd(),
      expect.any(AbortSignal),
      undefined,
    );
    expect(dispatch).toHaveBeenNthCalledWith(
      2,
      "2fa-tool",
      { value: "b" },
      process.cwd(),
      expect.any(AbortSignal),
      undefined,
    );
  });

  it("maps canonical and exact namespace keys to original tool names", async () => {
    const dispatch = vi.fn(async (name: string) => `${name}:text`);
    const executor = makeExecutor(["dev-tools"], dispatch);
    const code = [
      "const namespaced = await tools.dev_tools({});",
      'const exact = await tools["dev-tools"]({});',
      "return [namespaced, exact].join('|');",
    ].join("\n");

    await expect(executionOutput(executor, code)).resolves.toBe(
      "dev-tools:text|dev-tools:text",
    );
    expect(dispatch.mock.calls.map(([name]) => name)).toEqual(["dev-tools", "dev-tools"]);
  });

  it("does not present the tools namespace as a thenable or JSON serializer", async () => {
    const executor = makeExecutor(["read"]);
    const code = [
      "const resolved = await Promise.resolve(tools);",
      "return JSON.stringify([resolved === tools, JSON.stringify(tools)]);",
    ].join("\n");

    await expect(executionOutput(executor, code)).resolves.toBe('[true,"{}"]');
  });

  it("classifies blocked, unavailable, and unknown namespace calls", async () => {
    const executor = makeExecutor([], async () => "", undefined, ["direct_only"]);
    const code = [
      "const failures = await Promise.all([",
      "  settle(tools.ptc({})),",
      "  settle(tools.direct_only({})),",
      "  settle(tools.missing_tool({})),",
      "]);",
      "return JSON.stringify(failures.map((result) => result.ok ? null : result.error));",
    ].join("\n");

    const output = await executionOutput(executor, code);
    expect(JSON.parse(output)).toEqual([
      expect.objectContaining({ class: "blocked-tool", tool: "ptc" }),
      expect.objectContaining({ class: "unavailable-tool", tool: "direct_only" }),
      expect.objectContaining({ class: "unknown-tool", tool: "missing_tool" }),
    ]);
    expect(output).not.toContain("ReferenceError");
  });

  it("settles independent calls and records bounded execution details", async () => {
    const longTool = `read-${"x".repeat(200)}`;
    const dispatch = vi.fn(async (name: string) => {
      if (name === "fail-tool") throw new Error("credential-shaped-secret");
      return "kept";
    });
    const executor = makeExecutor([longTool, "fail-tool"], dispatch);
    const code = [
      "const results = await Promise.all([",
      `  settle(tools[${JSON.stringify(longTool)}]({ path: "/private/ok" })),`,
      '  settle(tools.fail_tool({ token: "credential-shaped-secret" })),',
      "]);",
      "return JSON.stringify(results);",
    ].join("\n");

    const result = await executor.execute(code, process.cwd());
    const details = Schema.decodeUnknownSync(PtcRunDetailsSchema)(result.details);
    expect(JSON.parse(result.output)).toEqual([
      { ok: true, value: "kept" },
      {
        ok: false,
        error: expect.objectContaining({
          class: "nested-tool",
          tool: "fail-tool",
          message: expect.stringContaining("credential-shaped-secret"),
        }),
      },
    ]);
    expect(details).toMatchObject({
      schemaVersion: 1,
      completion: PtcCompletion.Success,
      nestedCallCount: 2,
      completedNestedCallCount: 2,
      failedNestedCallCount: 1,
      toolCallCounts: [
        expect.objectContaining({ count: 1 }),
        { tool: "fail-tool", count: 1 },
      ],
      lastNestedCall: {
        tool: "fail-tool",
        ordinal: 2,
        status: PtcNestedCallStatus.Failed,
      },
    });
    expect(details.durationMs).toBeGreaterThanOrEqual(0);
    expect(details.toolCallCounts[0].tool.length).toBeLessThanOrEqual(80);
    expect(JSON.stringify(details)).not.toMatch(/private|credential-shaped-secret|kept/);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("retains bounded partial output and content-free details for nested failures", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("nested boom");
    });
    const error = await rejectedExecution(
      makeExecutor(["fail-tool"], dispatch),
      [
        'console.log("kept partial output");',
        'await tools.fail_tool({ path: "/private/secret-path" });',
      ].join("\n"),
    );

    expect(error.message).toContain("kept partial output");
    expect(error.details).toMatchObject({
      completion: PtcCompletion.Failure,
      failureClass: PtcFailureClass.NestedTool,
      nestedCallCount: 1,
      completedNestedCallCount: 1,
      failedNestedCallCount: 1,
      lastNestedCall: {
        tool: "fail-tool",
        ordinal: 1,
        status: PtcNestedCallStatus.Failed,
      },
    });
    expect(JSON.stringify(error.details)).not.toMatch(/private|secret-path|nested boom|partial output/);
  });

  it("marks output truncation without storing output content in details", async () => {
    const result = await makeExecutor().execute(
      `return "x".repeat(${MAX_OUTPUT_BYTES + 1_000});`,
      process.cwd(),
    );

    expect(result.output).toContain(
      `[PTC output truncated — showing first ${MAX_OUTPUT_BYTES} bytes of ${MAX_OUTPUT_BYTES + 1_000}]`,
    );
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(result.details.outputTruncated).toBe(true);
  });

  it("keeps the subprocess tool-call limit on the fd 3 path", async () => {
    const dispatch = vi.fn(async () => "ok");
    const error = await rejectedExecution(
      makeExecutor(["echo"], dispatch),
      "for (let i = 0; i <= 100; i++) await echo({ value: i });",
    );

    expect(error.phase).toBe(PtcExecutionPhase.Run);
    expect(error.message).toContain("exceeded 100 tool call limit");
    expect(dispatch).toHaveBeenCalledTimes(100);
  });

  it("classifies malformed and schema-invalid fd 3 messages as protocol failures", async () => {
    const cases = [
      ["not-json", "fd 3 emitted malformed JSON"],
      [JSON.stringify({ type: "unknown" }), "fd 3 emitted an invalid RPC message"],
    ] as const;

    for (const [line, reason] of cases) {
      const error = await rejectedExecution(
        makeExecutor(),
        [
          'const { writeFileSync } = await import("node:fs");',
          `writeFileSync(3, ${JSON.stringify(`${line}\n`)});`,
          'return "unreachable";',
        ].join("\n"),
      );

      expect(error.phase).toBe(PtcExecutionPhase.Protocol);
      expect(error.details).toMatchObject({
        completion: PtcCompletion.Failure,
        failureClass: PtcFailureClass.Infrastructure,
      });
      expect(error.message).toContain(reason);
    }
  });

  it("propagates caller cancellation to nested calls and closes the execution scope", async () => {
    const controller = new AbortController();
    let nestedSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const dispatch: ExecutorDispatch = async (_name, _params, _cwd, signal) => {
      nestedSignal = signal;
      markStarted();
      return new Promise<string>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const execution = makeExecutor(["wait"], dispatch).execute(
      "return await wait({});",
      process.cwd(),
      controller.signal,
    );

    await started;
    controller.abort(new Error("stop"));

    const outcome = await execution.catch((cause: unknown) => cause);
    expect(outcome).toBeInstanceOf(PtcExecutionError);
    if (!(outcome instanceof PtcExecutionError)) throw new Error("Expected PTC cancellation");
    const error = outcome;
    expect(error.message).toContain("PTC execution cancelled");
    expect(error.details).toMatchObject({
      completion: PtcCompletion.Failure,
      failureClass: PtcFailureClass.Cancellation,
      nestedCallCount: 1,
      lastNestedCall: { tool: "wait", status: PtcNestedCallStatus.Failed },
    });
    expect(nestedSignal?.aborted).toBe(true);
  });

  it("classifies timeout with a pending nested call", async () => {
    const dispatch: ExecutorDispatch = async () => new Promise<string>(() => undefined);
    const error = await rejectedExecution(
      makeExecutor(["slow-tool"], dispatch, 200),
      'return await tools.slow_tool({ path: "/private/slow" });',
    );

    expect(error.phase).toBe(PtcExecutionPhase.Run);
    expect(error.message).toContain("Completed nested tool calls: 0");
    expect(error.message).toContain("Last call: → slow-tool");
    expect(error.details).toMatchObject({
      completion: PtcCompletion.Failure,
      failureClass: PtcFailureClass.Timeout,
      nestedCallCount: 1,
      completedNestedCallCount: 0,
      failedNestedCallCount: 0,
      lastNestedCall: {
        tool: "slow-tool",
        ordinal: 1,
        status: PtcNestedCallStatus.Pending,
      },
    });
    expect(JSON.stringify(error.details)).not.toContain("/private/slow");
  });

  it("does not create global compatibility aliases for blocked tools", async () => {
    const blocked = ["ptc", "subagent", "jit_catch", "skill_build"];
    expect([...BLOCKED_TOOLS]).toEqual(blocked);
    const code = [
      "typeof ptc",
      "typeof subagent",
      "typeof jit_catch",
      "typeof skill_build",
    ].join(", ");

    await expect(
      executionOutput(makeExecutor(blocked), `return [${code}].join(",");`),
    ).resolves.toBe("undefined,undefined,undefined,undefined");
  });
});

describe("PTC source diagnostics", () => {
  it.each([
    ["zero", []],
    ["one", ["read"]],
    ["many", Array.from({ length: 20 }, (_, index) => `tool_${index}`)],
  ])("maps runtime failures with %s generated wrappers", async (_label, tools) => {
    const error = await rejectedExecution(
      makeExecutor(tools),
      ['const marker = "before";', 'throw new Error("runtime boom");', "return marker;"].join("\n"),
    );

    expect(error.phase).toBe(PtcExecutionPhase.Run);
    expect(error.details).toMatchObject({
      completion: PtcCompletion.Failure,
      failureClass: PtcFailureClass.UserScript,
    });
    expect(error.message).toMatch(/PTC script error at line 2:\d+/);
    expect(error.message).toContain("Reason: runtime boom");
    expect(error.message).toContain('1 | const marker = "before";');
    expect(error.message).toContain('2 | throw new Error("runtime boom");');
    expect(error.message).not.toMatch(/ptc-[a-z0-9]+\.mjs/);
  });

  it("maps transform failures to the user body through the typed Effect channel", async () => {
    const error = await rejectedExecution(
      makeExecutor(["read"]),
      ["const before = 1;", "const = 2;", "return before;"].join("\n"),
    );

    expect(error.phase).toBe(PtcExecutionPhase.Transform);
    expect(error.details).toMatchObject({
      completion: PtcCompletion.Failure,
      failureClass: PtcFailureClass.Transformation,
    });
    expect(error.message).toContain("PTC transform error at line 2:7");
    expect(error.message).toContain('Reason: Expected identifier but found "="');
    expect(error.message).toContain("1 | const before = 1;");
    expect(error.message).toContain("2 | const = 2;");
    expect(error.message).not.toMatch(/ptc-[a-z0-9]+\.mjs/);
  });
});
