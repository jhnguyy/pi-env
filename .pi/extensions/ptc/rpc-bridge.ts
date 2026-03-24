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
import { formatError } from "../_shared/errors";
import { killGracefully, MAX_STDERR_BYTES } from "./types";
import type { DispatchFn, RpcOutbound, RpcInbound } from "./types";

export class RpcBridge {
  private userOutput: string[] = [];
  private completionResolve!: (output: string) => void;
  private completionReject!: (error: Error) => void;
  private stderr = "";
  private toolCallCount = 0;

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

    // Read subprocess stdout line-by-line
    const rl = createInterface({ input: proc.stdout!, terminal: false });
    rl.on("line", (line) => void this.handleLine(line));

    // Fallback settlement: fires when stdout closes (subprocess exits).
    // Handles the case where subprocess exits with code 0 without sending
    // "complete" (e.g. user code calls process.exit(0) directly).
    // If the promise is already settled, this resolve() is a no-op.
    rl.on("close", () => {
      this.completionResolve(this.userOutput.join("\n"));
    });

    // Capture stderr for diagnostics — capped to avoid unbounded growth.
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (this.stderr.length < MAX_STDERR_BYTES) {
        this.stderr += chunk.toString();
        if (this.stderr.length > MAX_STDERR_BYTES) {
          this.stderr = this.stderr.slice(0, MAX_STDERR_BYTES) + "\n[stderr truncated]";
        }
      }
    });

    proc.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        const msg = this.stderr.trim() || `PTC subprocess exited with code ${code}`;
        this.completionReject(new Error(msg));
      }
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

  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: RpcOutbound;
    try {
      msg = JSON.parse(trimmed) as RpcOutbound;
    } catch {
      // Not JSON — user console.log() output
      this.userOutput.push(line);
      return;
    }

    switch (msg.type) {
      case "tool_call":
        await this.handleToolCall(msg);
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

    this.onUpdate?.({
      content: [{ type: "text", text: `→ ${msg.tool} #${this.toolCallCount}` }],
      details: undefined,
    });

    try {
      const result = await this.dispatch(msg.tool, msg.params);
      this.send({ type: "tool_result", id: msg.id, result });
    } catch (err: unknown) {
      this.send({ type: "tool_error", id: msg.id, error: formatError(err, "ptc") });
    }
  }

  private send(msg: RpcInbound): void {
    if (this.proc.stdin && !this.proc.stdin.destroyed) {
      this.proc.stdin.write(JSON.stringify(msg) + "\n");
    }
  }
}
