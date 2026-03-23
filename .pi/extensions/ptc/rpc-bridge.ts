/**
 * @module ptc/rpc-bridge
 * @purpose Parent-side RPC handler for the PTC subprocess.
 *
 * Reads stdout from the subprocess line-by-line:
 *   - JSON lines → dispatch to ToolRegistry, write result to stdin
 *   - Plain lines → accumulate as user output (console.log)
 *
 * Writes tool results to subprocess stdin as JSON lines.
 */

import { createInterface } from "readline";
import type { ChildProcess } from "child_process";
import type { ExtensionContext, AgentToolUpdateCallback } from "@mariozechner/pi-coding-agent";
import type { ToolRegistry } from "./tool-registry";
import type { RpcOutbound, RpcInbound } from "./types";

export class RpcBridge {
  private userOutput: string[] = [];
  private completionResolve!: (output: string) => void;
  private completionReject!: (error: Error) => void;
  private stderr = "";
  private toolCallCount = 0;

  readonly completion: Promise<string>;

  constructor(
    private proc: ChildProcess,
    private registry: ToolRegistry,
    private cwd: string,
    private ctx: ExtensionContext,
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

    // Capture stderr for error diagnostics
    proc.stderr?.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });

    // Handle unexpected exit
    proc.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        const msg = this.stderr.trim() || `PTC subprocess exited with code ${code}`;
        this.completionReject(new Error(msg));
      }
    });

    proc.on("error", (err) => {
      this.completionReject(new Error(`PTC spawn error: ${err.message}`));
    });

    // Forward abort signal
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (proc.exitCode === null) proc.kill("SIGKILL");
          }, 5_000);
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
        // Combine console.log lines + explicit return value
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
    const label = `${msg.tool} #${this.toolCallCount}`;

    this.onUpdate?.({
      content: [{ type: "text", text: `→ ${label}` }],
      details: undefined,
    });

    try {
      const result = await this.registry.dispatch(
        msg.tool,
        msg.params,
        this.cwd,
        undefined, // signal: tool calls inside PTC are not individually cancellable
        this.ctx,
      );
      this.send({ type: "tool_result", id: msg.id, result });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.send({ type: "tool_error", id: msg.id, error: message });
    }
  }

  private send(msg: RpcInbound): void {
    if (this.proc.stdin && !this.proc.stdin.destroyed) {
      this.proc.stdin.write(JSON.stringify(msg) + "\n");
    }
  }
}
