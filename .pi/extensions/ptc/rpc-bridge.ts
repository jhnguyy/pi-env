/**
 * @module ptc/rpc-bridge
 * @purpose Parent-side RPC handler for the PTC subprocess.
 */

import { createInterface, type Interface } from "node:readline";
import { Readable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";
import { formatParamsPreview } from "../_shared/code-frame";
import { formatError } from "../_shared/errors";
import { PtcCancellationError, PtcProtocolError, PtcSubprocessError } from "./node-runtime";
import { PtcExecutionTracker } from "./execution-details";
import {
  MAX_STDERR_BYTES,
  MAX_OUTPUT_BYTES,
  MAX_TOOL_CALLS,
  PtcToolDispatchError,
  PtcToolFailureClass,
  type DispatchFn,
  type PtcToolFailure,
  type RpcOutbound,
  type RpcInbound,
} from "./types";

const OUTPUT_TRUNCATED = Buffer.from("\n[output truncated]");
const STDERR_TRUNCATED = Buffer.from("\n[stderr truncated]");

const RpcOutboundSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("tool_call"),
    id: Schema.String,
    tool: Schema.String,
    params: Schema.Record(Schema.String, Schema.Unknown),
  }),
  Schema.Struct({
    type: Schema.Literal("complete"),
    output: Schema.String,
    outputTruncated: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    message: Schema.String,
    stack: Schema.optionalKey(Schema.String),
    failure: Schema.optionalKey(
      Schema.Struct({
        class: Schema.Union([
          Schema.Literal(PtcToolFailureClass.Blocked),
          Schema.Literal(PtcToolFailureClass.Unavailable),
          Schema.Literal(PtcToolFailureClass.Inactive),
          Schema.Literal(PtcToolFailureClass.Unknown),
          Schema.Literal(PtcToolFailureClass.Nested),
          Schema.Literal(PtcToolFailureClass.UserScript),
        ]),
        tool: Schema.optionalKey(Schema.String),
        message: Schema.String,
      }),
    ),
  }),
]);
const decodeRpcOutbound = Schema.decodeUnknownSync(RpcOutboundSchema, {
  errors: "all",
  onExcessProperty: "error",
});

type RpcTerminal = Extract<RpcOutbound, { type: "complete" | "error" }>;

function appendBounded(
  current: Buffer,
  incoming: Buffer,
  limit: number,
  marker: Buffer,
): { value: Buffer; truncated: boolean } {
  if (current.length >= limit) return { value: current, truncated: true };
  const combined = Buffer.concat([current, incoming]);
  if (combined.length <= limit) return { value: combined, truncated: false };
  const markerLength = Math.min(marker.length, limit);
  const contentLength = Math.max(0, limit - markerLength);
  return {
    value: Buffer.concat(
      [combined.subarray(0, contentLength), marker.subarray(0, markerLength)],
      limit,
    ),
    truncated: true,
  };
}

function asBuffer(chunk: Buffer | string): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function combineOutput(userOutput: Buffer, returnValue: string): string {
  const stdout = userOutput.toString("utf8");
  if (!returnValue) return stdout;
  if (!stdout) return returnValue;
  return stdout.endsWith("\n") ? stdout + returnValue : `${stdout}\n${returnValue}`;
}

export interface RpcChildProcess {
  readonly stdin: ChildProcess["stdin"];
  readonly stdout: ChildProcess["stdout"];
  readonly stderr: ChildProcess["stderr"];
  readonly stdio: ChildProcess["stdio"];
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  off(event: "error", listener: (error: Error) => void): this;
  listenerCount(event: string | symbol): number;
}

function rpcOutput(proc: RpcChildProcess): Readable {
  const stream = proc.stdio[3];
  if (!(stream instanceof Readable)) {
    throw new PtcProtocolError({ reason: "fd 3 is not a readable pipe" });
  }
  return stream;
}

export class RpcBridge {
  private userOutput: Buffer = Buffer.alloc(0);
  private outputCapReached = false;
  private completionResolve!: (output: string) => void;
  private completionReject!: (error: Error) => void;
  private stderr: Buffer = Buffer.alloc(0);
  private toolCallCount = 0;
  private lastToolCallLabel = "";
  private stdoutClosed = false;
  private rpcClosed = false;
  private processExitCode: number | null | undefined = undefined;
  private processExitSignal: NodeJS.Signals | null | undefined = undefined;
  private terminal: RpcTerminal | undefined;
  private settled = false;
  private cleaned = false;
  private abortSignal?: AbortSignal;
  private readonly rl: Interface;
  private readonly onRpcLine = (line: string): void => {
    this.handleRpcLine(line);
  };
  private readonly onRpcClose = (): void => {
    this.rpcClosed = true;
    this.trySettle();
  };
  private readonly onStdoutData = (chunk: Buffer | string): void =>
    this.collectStdout(asBuffer(chunk));
  private readonly onStdoutEnd = (): void => {
    this.stdoutClosed = true;
    this.trySettle();
  };
  private readonly onStderrData = (chunk: Buffer | string): void =>
    this.collectStderr(asBuffer(chunk));
  private readonly onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.processExitCode = code;
    this.processExitSignal = signal;
    this.trySettle();
  };
  private readonly onError = (err: Error): void =>
    this.reject(new Error(`PTC spawn error: ${err.message}`));
  private readonly onAbort = (): void => this.reject(new PtcCancellationError());

  readonly completion: Promise<string>;

  constructor(
    private proc: RpcChildProcess,
    private dispatch: DispatchFn,
    signal?: AbortSignal,
    private onUpdate?: AgentToolUpdateCallback<unknown>,
    private readonly tracker = new PtcExecutionTracker(),
  ) {
    this.completion = new Promise<string>((resolve, reject) => {
      this.completionResolve = resolve;
      this.completionReject = reject;
    });

    const rpc = rpcOutput(proc);
    this.rl = createInterface({ input: rpc, terminal: false });
    this.rl.on("line", this.onRpcLine);
    this.rl.on("close", this.onRpcClose);
    proc.stdout?.on("data", this.onStdoutData);
    proc.stdout?.once("end", this.onStdoutEnd);
    proc.stderr?.on("data", this.onStderrData);
    proc.once("exit", this.onExit);
    proc.once("error", this.onError);

    this.abortSignal = signal;
    if (signal?.aborted) this.onAbort();
    else signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  getCompletedToolCallCount(): number {
    return this.tracker.completedNestedCallCount();
  }
  getLastToolCallLabel(): string {
    return this.lastToolCallLabel;
  }

  cancel(reason = "PTC execution cancelled"): void {
    this.reject(new Error(reason));
  }

  dispose(): void {
    this.reject(new Error("PTC RPC bridge disposed"));
  }

  private resolve(output: string): void {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    this.completionResolve(output);
  }

  private reject(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    this.completionReject(error);
  }

  private cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    this.rl.off("line", this.onRpcLine);
    this.rl.off("close", this.onRpcClose);
    this.rl.close();
    this.proc.stdout?.off("data", this.onStdoutData);
    this.proc.stdout?.off("end", this.onStdoutEnd);
    this.proc.stderr?.off("data", this.onStderrData);
    this.proc.off("exit", this.onExit);
    this.proc.off("error", this.onError);
    this.abortSignal?.removeEventListener("abort", this.onAbort);
  }

  private collectStdout(chunk: Buffer): void {
    if (this.settled || this.outputCapReached) return;
    const appended = appendBounded(this.userOutput, chunk, MAX_OUTPUT_BYTES, OUTPUT_TRUNCATED);
    this.userOutput = appended.value;
    this.outputCapReached = appended.truncated;
    if (appended.truncated) this.tracker.markOutputTruncated();
  }

  private collectStderr(chunk: Buffer): void {
    if (this.settled || this.stderr.length >= MAX_STDERR_BYTES) return;
    this.stderr = appendBounded(this.stderr, chunk, MAX_STDERR_BYTES, STDERR_TRUNCATED).value;
  }

  private trySettle(): void {
    if (this.settled || !this.stdoutClosed) return;

    if (this.terminal?.type === "complete") {
      if (this.terminal.outputTruncated) this.tracker.markOutputTruncated();
      this.resolve(combineOutput(this.userOutput, this.terminal.output));
      return;
    }
    if (this.terminal?.type === "error") {
      this.reject(
        new PtcSubprocessError({
          message: this.terminal.message,
          stack: this.terminal.stack,
          failure: this.terminal.failure,
          partialOutput: this.userOutput.toString("utf8"),
        }),
      );
      return;
    }

    if (
      !this.rpcClosed ||
      this.processExitCode === undefined ||
      this.processExitSignal === undefined
    )
      return;

    if (this.processExitSignal !== null) {
      this.reject(
        new Error(
          this.stderr.toString("utf8").trim() ||
            `PTC subprocess terminated by ${this.processExitSignal}`,
        ),
      );
    } else if (this.processExitCode !== 0 && this.processExitCode !== null) {
      const message =
        this.stderr.toString("utf8").trim() ||
        `PTC subprocess exited with code ${this.processExitCode}`;
      this.reject(new Error(message));
    } else {
      this.resolve(this.userOutput.toString("utf8"));
    }
  }

  private handleRpcLine(line: string): void {
    if (this.settled) return;
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.reject(new PtcProtocolError({ reason: "fd 3 emitted malformed JSON" }));
      return;
    }

    let msg: RpcOutbound;
    try {
      msg = decodeRpcOutbound(parsed);
    } catch {
      this.reject(new PtcProtocolError({ reason: "fd 3 emitted an invalid RPC message" }));
      return;
    }

    switch (msg.type) {
      case "tool_call":
        if (!this.terminal) void this.handleToolCall(msg);
        break;
      case "complete":
      case "error":
        this.terminal ??= msg;
        this.trySettle();
        break;
    }
  }

  private async handleToolCall(msg: {
    id: string;
    tool: string;
    params: Record<string, unknown>;
  }): Promise<void> {
    if (this.settled || this.terminal) return;
    if (this.toolCallCount >= MAX_TOOL_CALLS) {
      this.reject(new PtcProtocolError({ reason: `exceeded ${MAX_TOOL_CALLS} tool call limit` }));
      return;
    }
    this.toolCallCount++;
    const trackedCall = this.tracker.startNestedCall(msg.tool);
    const label = formatCallLabel(msg.tool, msg.params, this.toolCallCount);
    this.lastToolCallLabel = label;
    try {
      this.onUpdate?.({ content: [{ type: "text", text: label }], details: undefined });
    } catch (cause: unknown) {
      this.reject(new Error(`PTC update callback failed: ${formatError(cause, "ptc")}`));
      return;
    }

    try {
      const result = await this.dispatch(msg.tool, msg.params);
      this.tracker.completeNestedCall(trackedCall, false);
      if (!this.settled && !this.terminal) this.send({ type: "tool_result", id: msg.id, result });
    } catch (err: unknown) {
      this.tracker.completeNestedCall(trackedCall, true);
      if (this.settled || this.terminal) return;
      this.send({
        type: "tool_error",
        id: msg.id,
        failure: nestedToolFailure(msg.tool, msg.params, err),
      });
    }
  }

  private send(msg: RpcInbound): void {
    if (this.settled) return;
    const stdin = this.proc.stdin;
    if (!stdin || stdin.destroyed) {
      this.reject(new Error("PTC RPC input closed before a nested call completed"));
      return;
    }
    try {
      stdin.write(JSON.stringify(msg) + "\n", (error) => {
        if (error) this.reject(new Error(`PTC RPC write failed: ${error.message}`));
      });
    } catch (cause: unknown) {
      this.reject(new Error(`PTC RPC write failed: ${formatError(cause, "ptc")}`));
    }
  }
}

function nestedToolFailure(
  tool: string,
  params: Record<string, unknown>,
  cause: unknown,
): PtcToolFailure {
  if (cause instanceof PtcToolDispatchError) return cause.failure;
  return {
    class: PtcToolFailureClass.Nested,
    tool,
    message: [
      "PTC nested tool call failed",
      `Tool: ${tool}`,
      `Args: ${formatParamsPreview(params)}`,
      `Error: ${formatError(cause, "ptc")}`,
    ].join("\n"),
  };
}

function formatCallLabel(tool: string, params: Record<string, unknown>, n: number): string {
  const MAX_TOOL = 80;
  const MAX_VAL = 45;
  const shownTool = tool.length > MAX_TOOL ? `${tool.slice(0, MAX_TOOL - 1)}…` : tool;
  const entries = Object.entries(params);
  if (entries.length === 0) return `→ ${shownTool} #${n}`;
  const shown = entries.slice(0, 2).map(([k, v]) => {
    let val: string;
    if (typeof v === "string") val = `"${v.length > MAX_VAL ? v.substring(0, MAX_VAL) + "…" : v}"`;
    else {
      const s = JSON.stringify(v);
      val = s.length > MAX_VAL ? s.substring(0, MAX_VAL) + "…" : s;
    }
    return `${k}=${val}`;
  });
  const overflow = entries.length > 2 ? `  +${entries.length - 2}` : "";
  return `→ ${shownTool}(${shown.join(", ")})${overflow} #${n}`;
}
