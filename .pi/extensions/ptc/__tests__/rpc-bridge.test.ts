/**
 * RpcBridge unit tests.
 *
 * The mock uses separate stdout and fd 3 streams. This keeps transport claims at
 * the same boundary as a real ChildProcess without spawning Node for each case.
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { RpcBridge, type RpcChildProcess } from "../rpc-bridge";
import {
  MAX_OUTPUT_BYTES,
  MAX_STDERR_BYTES,
  MAX_TOOL_CALLS,
  PtcToolDispatchError,
  type RpcOutbound,
} from "../types";

interface MockProc {
  proc: RpcChildProcess;
  send: (msg: RpcOutbound) => void;
  stdout: (text: string) => void;
  exit: (code: number) => void;
  exitThenClose: (code: number) => void;
  terminate: (signal: NodeJS.Signals) => void;
  err: (text: string) => void;
  stdinText: () => string;
}

function makeMock(): MockProc {
  const ee = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const rpc = new PassThrough();
  const stdinChunks: Buffer[] = [];
  stdin.on("data", (chunk: Buffer) => stdinChunks.push(chunk));

  const stdio: ChildProcess["stdio"] = [stdin, stdout, stderr, rpc, undefined];
  const proc = Object.assign(ee, {
    stdout,
    stderr,
    stdin,
    stdio,
  }) satisfies RpcChildProcess;

  const closeStreams = (): void => {
    stdout.end();
    rpc.end();
  };

  return {
    proc,
    send: (msg) => rpc.write(JSON.stringify(msg) + "\n"),
    stdout: (text) => stdout.write(text),
    exit: (code) => {
      closeStreams();
      ee.emit("exit", code, null);
    },
    exitThenClose: (code) => {
      ee.emit("exit", code, null);
      closeStreams();
    },
    terminate: (signal) => {
      closeStreams();
      ee.emit("exit", null, signal);
    },
    err: (text) => stderr.write(text),
    stdinText: () => Buffer.concat(stdinChunks).toString("utf8"),
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const noDispatch: (tool: string, params: Record<string, unknown>) => Promise<string> = () =>
  Promise.resolve("");

async function rejectedBridge(bridge: RpcBridge): Promise<Error> {
  const result = await bridge.completion.then(
    (output) => output,
    (cause: unknown) => cause,
  );
  expect(result).toBeInstanceOf(Error);
  return result as Error;
}

describe("terminal settlement", () => {
  it("uses the first terminal message", async () => {
    const m = makeMock();
    const bridge = new RpcBridge(m.proc, noDispatch);
    m.send({ type: "complete", output: "first" });
    m.send({ type: "error", message: "late" });
    m.exit(0);
    expect(await bridge.completion).toBe("first");
  });

  it("removes process and stream listeners after settlement", async () => {
    const m = makeMock();
    const bridge = new RpcBridge(m.proc, noDispatch);
    m.send({ type: "complete", output: "done" });
    m.exit(0);
    await bridge.completion;

    expect(m.proc.listenerCount("exit")).toBe(0);
    expect(m.proc.listenerCount("error")).toBe(0);
    expect(m.proc.stdout?.listenerCount("data")).toBe(0);
    expect(m.proc.stderr?.listenerCount("data")).toBe(0);
  });
});

describe("fallback settlement and process diagnostics", () => {
  it("resolves with raw stdout on a clean exit without a complete message", async () => {
    const m = makeMock();
    const bridge = new RpcBridge(m.proc, noDispatch);
    m.stdout("output line\n");
    m.exit(0);
    expect(await bridge.completion).toBe("output line\n");
  });

  it("rejects a non-zero exit in both stream and process event orders", async () => {
    for (const exit of [(m: MockProc) => m.exit(1), (m: MockProc) => m.exitThenClose(1)]) {
      const m = makeMock();
      const bridge = new RpcBridge(m.proc, noDispatch);
      bridge.completion.catch(() => {});
      m.stdout("partial output");
      exit(m);
      await expect(bridge.completion).rejects.toThrow("code 1");
    }
  });

  it("uses bounded stderr for non-zero exit diagnostics", async () => {
    const m = makeMock();
    const bridge = new RpcBridge(m.proc, noDispatch);
    bridge.completion.catch(() => {});
    m.err("界".repeat(MAX_STDERR_BYTES));
    await flush();
    m.exit(1);
    const error = await rejectedBridge(bridge);
    expect(Buffer.byteLength(error.message)).toBeLessThanOrEqual(MAX_STDERR_BYTES);
    expect(error.message).toContain("stderr truncated");
  });

  it("rejects signal termination", async () => {
    const m = makeMock();
    const bridge = new RpcBridge(m.proc, noDispatch);
    bridge.completion.catch(() => {});
    m.terminate("SIGKILL");
    await expect(bridge.completion).rejects.toThrow("terminated by SIGKILL");
  });
});

describe("multiple tool calls", () => {
  it("dispatches calls concurrently and returns each result through stdin", async () => {
    const m = makeMock();
    const order: string[] = [];
    let resolveA!: (value: string) => void;
    let resolveB!: (value: string) => void;
    const bridge = new RpcBridge(m.proc, (tool) => {
      order.push(`start:${tool}`);
      return new Promise<string>((resolve) => {
        if (tool === "toolA") resolveA = resolve;
        else resolveB = resolve;
      });
    });

    m.send({ type: "tool_call", id: "c_0", tool: "toolA", params: {} });
    m.send({ type: "tool_call", id: "c_1", tool: "toolB", params: {} });
    await flush();
    expect(order).toEqual(["start:toolA", "start:toolB"]);

    resolveA("resultA");
    resolveB("resultB");
    await flush();
    expect(m.stdinText()).toContain(
      JSON.stringify({ type: "tool_result", id: "c_0", result: "resultA" }),
    );
    expect(m.stdinText()).toContain(
      JSON.stringify({ type: "tool_result", id: "c_1", result: "resultB" }),
    );

    m.send({ type: "complete", output: "done" });
    m.exit(0);
    expect(await bridge.completion).toBe("done");
  });

  it("rejects tool calls that bypass the child-side call limit", async () => {
    const m = makeMock();
    const bridge = new RpcBridge(m.proc, noDispatch);
    bridge.completion.catch(() => undefined);

    for (let index = 0; index <= MAX_TOOL_CALLS; index++) {
      m.send({ type: "tool_call", id: `c_${index}`, tool: "read", params: {} });
    }

    await expect(bridge.completion).rejects.toThrow(
      `exceeded ${MAX_TOOL_CALLS} tool call limit`,
    );
  });
});

describe("nested tool failures", () => {
  it("preserves a classified registry failure in the child response", async () => {
    const m = makeMock();
    const failure = {
      class: "unavailable-tool" as const,
      tool: "direct_only",
      message: "Call this tool directly.",
    };
    const bridge = new RpcBridge(m.proc, async () => {
      throw new PtcToolDispatchError(failure);
    });

    m.send({ type: "tool_call", id: "c_0", tool: "direct_only", params: {} });
    await flush();
    expect(JSON.parse(m.stdinText().trim())).toEqual({
      type: "tool_error",
      id: "c_0",
      failure,
    });

    m.send({ type: "complete", output: "done" });
    m.exit(0);
    await expect(bridge.completion).resolves.toBe("done");
  });
});

describe("raw stdout bound", () => {
  it("stops accumulating stdout at MAX_OUTPUT_BYTES", async () => {
    const m = makeMock();
    const bridge = new RpcBridge(m.proc, noDispatch);
    m.stdout("x".repeat(MAX_OUTPUT_BYTES + 10_000));
    m.send({ type: "complete", output: "" });
    m.exit(0);

    const result = await bridge.completion;
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(result).toContain("[output truncated");
  });
});
