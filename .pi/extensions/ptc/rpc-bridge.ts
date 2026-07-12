/**
 * @module ptc/rpc-bridge
 * @purpose Parent-side RPC handler for the PTC subprocess.
 */

import { createInterface, type Interface } from "readline";
import type { ChildProcess } from "child_process";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { formatParamsPreview } from "../_shared/code-frame";
import { formatError } from "../_shared/errors";
import { MAX_STDERR_BYTES, MAX_OUTPUT_BYTES } from "./types";
import type { DispatchFn, RpcOutbound, RpcInbound } from "./types";

const OUTPUT_TRUNCATED = Buffer.from("\n[output truncated]");
const STDERR_TRUNCATED = Buffer.from("\n[stderr truncated]");

function appendBounded(current: Buffer, incoming: Buffer, limit: number, marker: Buffer): { value: Buffer; truncated: boolean } {
  if (current.length >= limit) return { value: current, truncated: true };
  const combined = Buffer.concat([current, incoming]);
  if (combined.length <= limit) return { value: combined, truncated: false };
  const markerLength = Math.min(marker.length, limit);
  const contentLength = Math.max(0, limit - markerLength);
  return {
    value: Buffer.concat([combined.subarray(0, contentLength), marker.subarray(0, markerLength)], limit),
    truncated: true,
  };
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
  private processExitCode: number | null | undefined = undefined;
  private processExitSignal: NodeJS.Signals | null | undefined = undefined;
  private settled = false;
  private cleaned = false;
  private abortSignal?: AbortSignal;
  private readonly rl: Interface;
  private readonly onLine = (line: string): void => { void this.handleLine(line); };
  private readonly onReadlineClose = (): void => { this.stdoutClosed = true; this.tryFallbackSettle(); };
  private readonly onStderrData = (chunk: Buffer): void => this.collectStderr(chunk);
  private readonly onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.processExitCode = code;
    this.processExitSignal = signal;
    this.tryFallbackSettle();
  };
  private readonly onError = (err: Error): void => this.reject(new Error(`PTC spawn error: ${err.message}`));
  private readonly onAbort = (): void => this.reject(new Error("PTC execution cancelled"));

  readonly completion: Promise<string>;

  constructor(
    private proc: ChildProcess,
    private dispatch: DispatchFn,
    signal?: AbortSignal,
    private onUpdate?: AgentToolUpdateCallback<unknown>,
  ) {
    this.completion = new Promise<string>((resolve, reject) => {
      this.completionResolve = resolve;
      this.completionReject = reject;
    });

    this.rl = createInterface({ input: proc.stdout!, terminal: false });
    this.rl.on("line", this.onLine);
    this.rl.on("close", this.onReadlineClose);
    proc.stderr?.on("data", this.onStderrData);
    proc.once("exit", this.onExit);
    proc.once("error", this.onError);

    this.abortSignal = signal;
    if (signal?.aborted) this.onAbort();
    else signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  getToolCallCount(): number { return this.toolCallCount; }
  getLastToolCallLabel(): string { return this.lastToolCallLabel; }

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
    this.rl.off("line", this.onLine);
    this.rl.off("close", this.onReadlineClose);
    this.rl.close();
    this.proc.stderr?.off("data", this.onStderrData);
    this.proc.off("exit", this.onExit);
    this.proc.off("error", this.onError);
    this.abortSignal?.removeEventListener("abort", this.onAbort);
  }

  private collectStderr(chunk: Buffer): void {
    if (this.settled || this.stderr.length >= MAX_STDERR_BYTES) return;
    this.stderr = appendBounded(this.stderr, chunk, MAX_STDERR_BYTES, STDERR_TRUNCATED).value;
  }

  private tryFallbackSettle(): void {
    if (this.settled || !this.stdoutClosed || this.processExitCode === undefined || this.processExitSignal === undefined) return;
    if (this.processExitSignal !== null) {
      this.reject(new Error(this.stderr.toString("utf8").trim() || `PTC subprocess terminated by ${this.processExitSignal}`));
    } else if (this.processExitCode !== 0 && this.processExitCode !== null) {
      const msg = this.stderr.toString("utf8").trim() || `PTC subprocess exited with code ${this.processExitCode}`;
      this.reject(new Error(msg));
    } else {
      this.resolve(this.userOutput.toString("utf8"));
    }
  }

  private async handleLine(line: string): Promise<void> {
    if (this.settled) return;
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: RpcOutbound;
    try {
      msg = JSON.parse(trimmed) as RpcOutbound;
    } catch {
      if (this.outputCapReached) return;
      const prefix = this.userOutput.length > 0 ? "\n" : "";
      const appended = appendBounded(
        this.userOutput,
        Buffer.from(prefix + line),
        MAX_OUTPUT_BYTES,
        OUTPUT_TRUNCATED,
      );
      this.userOutput = appended.value;
      this.outputCapReached = appended.truncated;
      return;
    }

    switch (msg.type) {
      case "tool_call":
        void this.handleToolCall(msg);
        break;
      case "complete": {
        const parts: string[] = [];
        const output = this.userOutput.toString("utf8");
        if (output) parts.push(output);
        if (msg.output) parts.push(msg.output);
        this.resolve(parts.join("\n"));
        break;
      }
      case "error": {
        const err = new Error(msg.message);
        if (msg.stack) err.stack = msg.stack;
        this.reject(err);
        break;
      }
    }
  }

  private async handleToolCall(msg: { id: string; tool: string; params: Record<string, unknown> }): Promise<void> {
    if (this.settled) return;
    this.toolCallCount++;
    const label = formatCallLabel(msg.tool, msg.params, this.toolCallCount);
    this.lastToolCallLabel = label;
    this.onUpdate?.({ content: [{ type: "text", text: label }], details: undefined });

    try {
      const result = await this.dispatch(msg.tool, msg.params);
      if (!this.settled) this.send({ type: "tool_result", id: msg.id, result });
    } catch (err: unknown) {
      if (this.settled) return;
      const pretty = [
        "PTC nested tool call failed",
        `Tool: ${msg.tool}`,
        `Args: ${formatParamsPreview(msg.params)}`,
        `Error: ${formatError(err, "ptc")}`,
      ].join("\n");
      this.send({ type: "tool_error", id: msg.id, error: pretty });
    }
  }

  private send(msg: RpcInbound): void {
    if (this.settled) return;
    if (this.proc.stdin && !this.proc.stdin.destroyed) this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }
}

function formatCallLabel(tool: string, params: Record<string, unknown>, n: number): string {
  const MAX_VAL = 45;
  const entries = Object.entries(params);
  if (entries.length === 0) return `→ ${tool} #${n}`;
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
  return `→ ${tool}(${shown.join(", ")})${overflow} #${n}`;
}
