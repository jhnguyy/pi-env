/**
 * @module ptc/rpc-bridge
 * @purpose Parent-side RPC handler for the PTC subprocess.
 *
 * Reads subprocess stdout line-by-line:
 *   - JSON lines → dispatch tool call, write result to stdin
 *   - Plain lines → accumulate as user output (console.log)
 *
 * Writes tool results to subprocess stdin as JSON lines.
 */

import { createInterface } from "readline";
import type { ChildProcess } from "child_process";
import type { AgentToolUpdateCallback } from "@mariozechner/pi-coding-agent";
import { formatParamsPreview } from "../_shared/code-frame";
import { formatError } from "../_shared/errors";
import { killGracefully, MAX_STDERR_BYTES, MAX_OUTPUT_BYTES } from "./types";
import type { DispatchFn, RpcOutbound, RpcInbound } from "./types";

export class RpcBridge {
  private userOutput: string[] = [];
  private userOutputBytes = 0;
  private outputCapReached = false;
  private completionResolve!: (output: string) => void;
  private completionReject!: (error: Error) => void;
  private stderr = "";
  private toolCallCount = 0;
  private lastToolCallLabel = "";

  private stdoutClosed = false;
  private processExitCode: number | null | undefined = undefined;

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

    const rl = createInterface({ input: proc.stdout!, terminal: false });
    rl.on("line", (line) => void this.handleLine(line));

    rl.on("close", () => {
      this.stdoutClosed = true;
      this.tryFallbackSettle();
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      if (this.stderr.length < MAX_STDERR_BYTES) {
        this.stderr += chunk.toString();
        if (this.stderr.length > MAX_STDERR_BYTES) {
          this.stderr = this.stderr.slice(0, MAX_STDERR_BYTES) + "\n[stderr truncated]";
        }
      }
    });

    proc.on("exit", (code) => {
      this.processExitCode = code;
      this.tryFallbackSettle();
    });

    proc.on("error", (err) => {
      this.completionReject(new Error(`PTC spawn error: ${err.message}`));
    });

    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          killGracefully(proc);
          this.completionReject(new Error("PTC execution cancelled"));
        },
        { once: true },
      );
    }
  }

  getToolCallCount(): number {
    return this.toolCallCount;
  }

  getLastToolCallLabel(): string {
    return this.lastToolCallLabel;
  }

  private tryFallbackSettle(): void {
    if (!this.stdoutClosed || this.processExitCode === undefined) return;

    if (this.processExitCode !== 0 && this.processExitCode !== null) {
      const msg = this.stderr.trim() || `PTC subprocess exited with code ${this.processExitCode}`;
      this.completionReject(new Error(msg));
    } else {
      this.completionResolve(this.userOutput.join("\n"));
    }
  }

  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: RpcOutbound;
    try {
      msg = JSON.parse(trimmed) as RpcOutbound;
    } catch {
      if (this.userOutputBytes < MAX_OUTPUT_BYTES) {
        this.userOutput.push(line);
        this.userOutputBytes += line.length + 1;
      } else if (!this.outputCapReached) {
        this.outputCapReached = true;
        this.userOutput.push(`[output truncated — exceeded ${MAX_OUTPUT_BYTES} byte limit mid-execution]`);
      }
      return;
    }

    switch (msg.type) {
      case "tool_call":
        void this.handleToolCall(msg);
        break;

      case "complete": {
        const parts: string[] = [];
        if (this.userOutput.length > 0) parts.push(this.userOutput.join("\n"));
        if (msg.output) parts.push(msg.output);
        this.completionResolve(parts.join("\n"));
        break;
      }

      case "error": {
        const err = new Error(msg.message);
        if (msg.stack) err.stack = msg.stack;
        this.completionReject(err);
        break;
      }
    }
  }

  private async handleToolCall(msg: {
    id: string;
    tool: string;
    params: Record<string, unknown>;
  }): Promise<void> {
    this.toolCallCount++;
    const label = formatCallLabel(msg.tool, msg.params, this.toolCallCount);
    this.lastToolCallLabel = label;

    this.onUpdate?.({
      content: [{ type: "text", text: label }],
      details: undefined,
    });

    try {
      const result = await this.dispatch(msg.tool, msg.params);
      this.send({ type: "tool_result", id: msg.id, result });
    } catch (err: unknown) {
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
    if (this.proc.stdin && !this.proc.stdin.destroyed) {
      this.proc.stdin.write(JSON.stringify(msg) + "\n");
    }
  }
}

function formatCallLabel(tool: string, params: Record<string, unknown>, n: number): string {
  const MAX_VAL = 45;
  const entries = Object.entries(params);
  if (entries.length === 0) return `→ ${tool} #${n}`;

  const shown = entries.slice(0, 2).map(([k, v]) => {
    let val: string;
    if (typeof v === "string") {
      val = `"${v.length > MAX_VAL ? v.substring(0, MAX_VAL) + "…" : v}"`;
    } else {
      const s = JSON.stringify(v);
      val = s.length > MAX_VAL ? s.substring(0, MAX_VAL) + "…" : s;
    }
    return `${k}=${val}`;
  });

  const overflow = entries.length > 2 ? `  +${entries.length - 2}` : "";
  return `→ ${tool}(${shown.join(", ")})${overflow} #${n}`;
}

