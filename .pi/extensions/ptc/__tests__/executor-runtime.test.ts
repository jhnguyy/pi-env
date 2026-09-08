import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildSync } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { PtcExecutor } from "../executor";
import { PtcExecutionError, PtcExecutionPhase } from "../node-runtime";
import type { ToolRegistry } from "../tool-registry";

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

function makeExecutor(
  toolNames: string[] = [],
  dispatch: (toolName: string, params: Record<string, unknown>) => Promise<string> = async () => "",
): PtcExecutor {
  const registry = {
    getAvailableTools: () => toolNames.map(tool),
    dispatch,
  } as unknown as ToolRegistry;
  return new PtcExecutor({} as ExtensionAPI, registry, preamblePath);
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

    await expect(executor.execute(code, process.cwd())).resolves.toBe(lines.join("\n") + "\nreal");
  });

  it("mixes stdout with multiple fd 3 calls and returns each result through stdin", async () => {
    const dispatch = vi.fn(
      async (name: string, params: Record<string, unknown>) => `${name}:${String(params.value)}`,
    );
    const executor = makeExecutor(["echo"], dispatch);
    const code = [
      'console.log("before");',
      'const first = await echo({ value: "a" });',
      'const second = await echo({ value: "b" });',
      "console.log(first);",
      "return second;",
    ].join("\n");

    await expect(executor.execute(code, process.cwd())).resolves.toBe("before\necho:a\necho:b");
    expect(dispatch).toHaveBeenNthCalledWith(
      1,
      "echo",
      { value: "a" },
      process.cwd(),
      expect.any(AbortSignal),
      undefined,
    );
    expect(dispatch).toHaveBeenNthCalledWith(
      2,
      "echo",
      { value: "b" },
      process.cwd(),
      expect.any(AbortSignal),
      undefined,
    );
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

  it("classifies malformed fd 3 messages as protocol failures", async () => {
    const error = await rejectedExecution(
      makeExecutor(),
      [
        'const { writeFileSync } = await import("node:fs");',
        'writeFileSync(3, "not-json\\n");',
        'return "unreachable";',
      ].join("\n"),
    );

    expect(error.phase).toBe(PtcExecutionPhase.Protocol);
    expect(error.message).toContain("fd 3 emitted malformed JSON");
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
    expect(error.message).toContain("PTC transform error at line 2:7");
    expect(error.message).toContain('Reason: Expected identifier but found "="');
    expect(error.message).toContain("1 | const before = 1;");
    expect(error.message).toContain("2 | const = 2;");
    expect(error.message).not.toMatch(/ptc-[a-z0-9]+\.mjs/);
  });
});
