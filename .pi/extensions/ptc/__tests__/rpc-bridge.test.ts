/**
 * RpcBridge unit tests
 *
 * Uses a mock ChildProcess (EventEmitter + PassThrough streams) to exercise
 * the settlement logic without spawning real subprocesses.
 *
 * Coverage:
 *   - "complete" message path
 *   - "error" message path
 *   - Fallback: clean exit without "complete" → resolves with console.log output
 *   - Race fix: rl.close before proc.exit for non-zero code → should REJECT
 *   - Race fix: proc.exit before rl.close for non-zero code → should REJECT
 *   - Concurrent tool_call dispatch (two calls before either result arrives)
 *   - Output cap: userOutput stops accumulating past MAX_OUTPUT_BYTES
 *   - Stderr included in rejection message for non-zero exit
 */

import { describe, it, expect } from "bun:test";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import type { ChildProcess } from "child_process";
import { RpcBridge } from "../rpc-bridge";
import { MAX_OUTPUT_BYTES } from "../types";

// ─── Mock ChildProcess ────────────────────────────────────────────────────────

interface MockProc {
  proc: ChildProcess;
  /** Write a JSON RPC message as a line to the subprocess stdout. */
  send: (msg: object) => void;
  /** Write a plain text line to subprocess stdout (console.log simulation). */
  log: (text: string) => void;
  /** Close stdout and emit exit(code). Order matches Node's real behaviour: close first. */
  exit: (code: number) => void;
  /** Emit exit(code) THEN close stdout (reversed order, for race testing). */
  exitThenClose: (code: number) => void;
  /** Write to stderr. */
  err: (text: string) => void;
}

function makeMock(): MockProc {
  const ee = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();

  const proc = Object.assign(ee, {
    stdout,
    stderr,
    stdin,
    exitCode: null as number | null,
    kill: (_signal?: string) => {},
  }) as unknown as ChildProcess;

  return {
    proc,
    send: (msg) => stdout.write(JSON.stringify(msg) + "\n"),
    log: (text) => stdout.write(text + "\n"),
    exit: (code) => {
      (proc as any).exitCode = code;
      stdout.end();           // close fires rl.close
      ee.emit("exit", code);  // then exit event
    },
    exitThenClose: (code) => {
      (proc as any).exitCode = code;
      ee.emit("exit", code);  // exit fires first
      stdout.end();           // rl.close fires after
    },
    err: (text) => stderr.write(text),
  };
}

/** Flush microtasks + I/O so readline can process buffered data. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const noDispatch: (tool: string, params: Record<string, unknown>) => Promise<string> =
  () => Promise.resolve("");

// ─── "complete" message ───────────────────────────────────────────────────────

describe("complete message", () => {
  it("resolves with the output field", async () => {
    const m = makeMock();
    const bridge = new RpcBridge(m.proc, noDispatch);
    m.send({ type: "complete", output: "hello world" });
    await flush();
    expect(await bridge.completion).toBe("hello world");
  });

  it("combines console.log lines with return value output", async () => {
    const m = makeMock();
    const bridge = new RpcBridge(m.proc, noDispatch);
    m.log("line one");
    m.log("line two");
    m.send({ type: "complete", output: "return value" });
    await flush();
    expect(await bridge.completion).toBe("line one\nline two\nreturn value");
  });

  it("resolves with only console.log when output is empty string", async () => {
    const m = makeMock();
    const bridge = new RpcBridge(m.proc, noDispatch);
    m.log("logged");
    m.send({ type: "complete", output: "" });
    await flush();
    expect(await bridge.completion).toBe("logged");
  });
});

// ─── "error" message ─────────────────────────────────────────────────────────

describe("error message", () => {
  it("rejects with the message field", async () => {
    const m = makeMock();
    const bridge = new RpcBridge(m.proc, noDispatch);
    // Attach no-op catch before the rejection fires to prevent unhandled-rejection
    // warnings; the rejects.toThrow() assertion below re-attaches its own handler.
    bridge.completion.catch(() => {});
    m.send({ type: "error", message: "script crashed" });
    await flush();
    await expect(bridge.completion).rejects.toThrow("script crashed");
  });
});

// ─── Fallback settlement (no "complete" message) ──────────────────────────────

describe("fallback settlement", () => {
  it("resolves with accumulated output on clean exit (no complete message)", async () => {
    const m = makeMock();
    const bridge = new RpcBridge(m.proc, noDispatch);
    m.log("output line");
    m.exit(0);
    await flush();
    expect(await bridge.completion).toBe("output line");
  });

  it("resolves with empty string on clean exit with no output", async () => {
    const m = makeMock();
    const bridge = new RpcBridge(m.proc, noDispatch);
    m.exit(0);
    await flush();
    expect(await bridge.completion).toBe("");
  });
});

// ─── Race condition fix (rl.close vs proc.exit ordering) ─────────────────────

describe("race fix: non-zero exit always rejects", () => {
  it("rejects when rl.close fires before proc.exit (non-zero)", async () => {
    const m = makeMock();
    const bridge = new RpcBridge(m.proc, noDispatch);
    bridge.completion.catch(() => {});
    m.log("partial output");
    // exit() closes stdout first, then emits exit — the critical race order
    m.exit(1);
    await flush();
    await expect(bridge.completion).rejects.toThrow("code 1");
  });

  it("rejects when proc.exit fires before rl.close (non-zero)", async () => {
    const m = makeMock();
    const bridge = new RpcBridge(m.proc, noDispatch);
    bridge.completion.catch(() => {});
    m.log("partial output");
    // exitThenClose() emits exit first, then closes stdout
    m.exitThenClose(1);
    await flush();
    await expect(bridge.completion).rejects.toThrow("code 1");
  });

  it("uses stderr content in rejection message when available", async () => {
    const m = makeMock();
    const bridge = new RpcBridge(m.proc, noDispatch);
    bridge.completion.catch(() => {});
    m.err("bun: syntax error near line 5\n");
    await flush();
    m.exit(1);
    await flush();
    await expect(bridge.completion).rejects.toThrow("bun: syntax error near line 5");
  });

  it("falls back to exit-code message when stderr is empty", async () => {
    const m = makeMock();
    const bridge = new RpcBridge(m.proc, noDispatch);
    bridge.completion.catch(() => {});
    m.exit(2);
    await flush();
    await expect(bridge.completion).rejects.toThrow("exited with code 2");
  });
});

// ─── Concurrent tool_call dispatch ───────────────────────────────────────────

describe("concurrent tool_call dispatch", () => {
  it("dispatches two tool_calls concurrently — both start before either resolves", async () => {
    const m = makeMock();
    const order: string[] = [];
    let resolveA!: (v: string) => void;
    let resolveB!: (v: string) => void;

    const dispatch = (tool: string, _params: Record<string, unknown>): Promise<string> => {
      order.push(`start:${tool}`);
      return new Promise<string>((resolve) => {
        if (tool === "toolA") resolveA = resolve;
        else resolveB = resolve;
      });
    };

    const bridge = new RpcBridge(m.proc, dispatch);

    // Send two tool_calls before either is resolved
    m.send({ type: "tool_call", id: "c_0", tool: "toolA", params: {} });
    m.send({ type: "tool_call", id: "c_1", tool: "toolB", params: {} });
    await flush();

    // Both dispatches must have started before either resolved
    expect(order).toEqual(["start:toolA", "start:toolB"]);

    // Resolve both and close
    resolveA("resultA");
    resolveB("resultB");
    await flush();
    m.send({ type: "complete", output: "done" });
    await flush();
    expect(await bridge.completion).toBe("done");
  });
});

// ─── Output cap ──────────────────────────────────────────────────────────────

describe("output cap", () => {
  it("stops accumulating userOutput past MAX_OUTPUT_BYTES", async () => {
    const m = makeMock();
    const bridge = new RpcBridge(m.proc, noDispatch);

    // Write enough lines to exceed the cap
    const bigLine = "x".repeat(1000);
    const count = Math.ceil(MAX_OUTPUT_BYTES / bigLine.length) + 10;
    for (let i = 0; i < count; i++) m.log(bigLine);
    m.send({ type: "complete", output: "" });
    await flush();

    const result = await bridge.completion;
    expect(result.length).toBeLessThan(MAX_OUTPUT_BYTES + 200); // 200 slack for truncation message
    expect(result).toContain("[output truncated");
  });
});
