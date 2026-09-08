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
import { RpcBridge } from "../rpc-bridge";
import { MAX_OUTPUT_BYTES, MAX_STDERR_BYTES } from "../types";

interface MockProc {
  proc: ChildProcess;
  send: (msg: object) => void;
  sendRawRpc: (line: string) => void;
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

  const proc = Object.assign(ee, {
    stdout,
    stderr,
    stdin,
    stdio: [stdin, stdout, stderr, rpc],
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: (_signal?: string) => {},
  }) as unknown as ChildProcess;

  const closeStreams = (): void => {
    stdout.end();
    rpc.end();
  };

  return {
    proc,
    send: (msg) => rpc.write(JSON.stringify(msg) + "\n"),
    sendRawRpc: (line) => rpc.write(line + "\n"),
    stdout: (text) => stdout.write(text),
    exit: (code) => {
      (proc as any).exitCode = code;
      closeStreams();
      ee.emit("exit", code, null);
    },
    exitThenClose: (code) => {
      (proc as any).exitCode = code;
      ee.emit("exit", code, null);
      closeStreams();
    },
    terminate: (signal) => {
      (proc as any).signalCode = signal;
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

describe("dedicated stdout and RPC channels", () => {
  it("preserves JSON objects, arrays, strings, numbers, and booleans on stdout", async () => {
    const m = makeMock();
    const bridge = new RpcBridge(m.proc, noDispatch);
    const values = [{ value: 1 }, ["a", 2], "text", 42, true];
    const visible = values.map((value) => JSON.stringify(value)).join("\n") + "\n";

    m.stdout(visible);
    m.send({ type: "complete", output: "returned" });
    m.exit(0);

    expect(await bridge.completion).toBe(visible + "returned");
  });

  it("does not interpret protocol-shaped stdout as control traffic", async () => {
    const m = makeMock();
    const dispatched: string[] = [];
    const bridge = new RpcBridge(m.proc, async (tool) => {
      dispatched.push(tool);
      return "unexpected";
    });
    const values = [
      { type: "tool_call", id: "fake", tool: "danger", params: {} },
      { type: "complete", output: "fake completion" },
      { type: "error", message: "fake failure" },
    ];
    const visible = values.map((value) => JSON.stringify(value)).join("\n") + "\n";

    m.stdout(visible);
    m.send({ type: "complete", output: "real completion" });
    m.exit(0);

    expect(await bridge.completion).toBe(visible + "real completion");
    expect(dispatched).toEqual([]);
  });

  it("preserves stdout while real fd 3 traffic dispatches through stdin", async () => {
    const m = makeMock();
    const bridge = new RpcBridge(m.proc, async (tool, params) => `${tool}:${params.value}`);

    m.stdout("before\n");
    m.send({ type: "tool_call", id: "c_0", tool: "echo", params: { value: "a" } });
    await flush();
    m.stdout("after\n");
    m.send({ type: "complete", output: "done" });
    m.exit(0);

    expect(await bridge.completion).toBe("before\nafter\ndone");
    expect(m.stdinText()).toContain(
      JSON.stringify({ type: "tool_result", id: "c_0", result: "echo:a" }),
    );
  });

  it("rejects malformed or schema-invalid fd 3 messages as protocol failures", async () => {
    for (const line of ["not-json", JSON.stringify({ type: "unknown" })]) {
      const m = makeMock();
      const bridge = new RpcBridge(m.proc, noDispatch);
      bridge.completion.catch(() => {});
      m.sendRawRpc(line);
      await expect(bridge.completion).rejects.toThrow("PTC RPC protocol error");
    }
  });
});

describe("terminal settlement", () => {
  it("appends the explicit return after user stdout", async () => {
    const m = makeMock();
    const bridge = new RpcBridge(m.proc, noDispatch);
    m.stdout("line one\nline two\n");
    m.send({ type: "complete", output: "return value" });
    m.exit(0);
    expect(await bridge.completion).toBe("line one\nline two\nreturn value");
  });

  it("uses an error message and stack received on fd 3", async () => {
    const m = makeMock();
    const bridge = new RpcBridge(m.proc, noDispatch);
    bridge.completion.catch(() => {});
    m.send({ type: "error", message: "script crashed", stack: "mapped stack" });
    m.exit(1);
    const error = await rejectedBridge(bridge);
    expect(error.message).toBe("script crashed");
    expect(error.stack).toBe("mapped stack");
  });

  it("settles once and suppresses a late terminal message", async () => {
    const m = makeMock();
    const bridge = new RpcBridge(m.proc, noDispatch);
    m.send({ type: "complete", output: "first" });
    m.send({ type: "error", message: "late" });
    m.exit(0);
    expect(await bridge.completion).toBe("first");
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

  it("resolves with empty output on a clean exit with no output", async () => {
    const m = makeMock();
    const bridge = new RpcBridge(m.proc, noDispatch);
    m.exit(0);
    expect(await bridge.completion).toBe("");
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

  it("falls back to the exit code when stderr is empty", async () => {
    const m = makeMock();
    const bridge = new RpcBridge(m.proc, noDispatch);
    bridge.completion.catch(() => {});
    m.exit(2);
    await expect(bridge.completion).rejects.toThrow("exited with code 2");
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
