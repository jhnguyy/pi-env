/**
 * @module ptc/rpc-bridge
 * @purpose Parent-side RPC handler for the PTC subprocess.
 *
 * Reads subprocess stdout line-by-line:
 *   - JSON lines → dispatch tool call, write result to stdin
 *   - Plain lines → accumulate as user output (console.log)
 *
 * Writes tool results to subprocess stdin as JSON lines.
 *
 * ## Concurrency model
 *
 * `handleLine` is async and called with void — readline never awaits it.
 * Multiple tool_call messages arriving in the same event loop turn each
 * start their own `handleToolCall` concurrently. This is intentional:
 * subprocess code using `Promise.all([toolA(...), toolB(...)])` correctly
 * results in both dispatches running in parallel in the parent.
 *
 * ## Settlement ordering
 *
 * Both `rl.close` (stdout EOF) and `proc.exit` must fire before the fallback
 * settlement path runs. This prevents a race where `rl.close` fires first and
 * spuriously resolves the promise with partial output, silently swallowing a
 * non-zero exit code. The normal "complete"/"error" message paths settle the
 * promise immediately without waiting for both events.
 */

import { createInterface } from "readline";
import type { ChildProcess } from "child_process";
import type { AgentToolUpdateCallback } from "@mariozechner/pi-coding-agent";
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

  // Both must be set before tryFallbackSettle() will act (fix for rl.close/proc.exit race).
  private stdoutClosed = false;
  private processExitCode: number | null | undefined = undefined; // undefined = not yet received

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

    // Fallback settlement: wait for BOTH stdout-close AND proc-exit before
    // deciding how to settle. This eliminates the race where rl.close fires
    // before proc.exit for a failing subprocess and resolves with partial output.
    // If the promise is already settled (via "complete"/"error" message), these
    // calls are no-ops.
    rl.on("close", () => {
      this.stdoutClosed = true;
      this.tryFallbackSettle();
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

  private tryFallbackSettle(): void {
    if (!this.stdoutClosed || this.processExitCode === undefined) return;

    if (this.processExitCode !== 0 && this.processExitCode !== null) {
      const msg = this.stderr.trim() || `PTC subprocess exited with code ${this.processExitCode}`;
      this.completionReject(new Error(msg));
    } else {
      // Clean exit (code 0) or signal-kill (null) without a "complete" message —
      // resolve with whatever console.log output accumulated.
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
      // Not JSON — user console.log() output. Cap to avoid parent OOM.
      if (this.userOutputBytes < MAX_OUTPUT_BYTES) {
        this.userOutput.push(line);
        this.userOutputBytes += line.length + 1; // +1 for the newline
      } else if (!this.outputCapReached) {
        this.outputCapReached = true;
        this.userOutput.push(`[output truncated — exceeded ${MAX_OUTPUT_BYTES} byte limit mid-execution]`);
      }
      return;
    }

    switch (msg.type) {
      case "tool_call":
        // Fire-and-forget: allows concurrent tool_calls to be dispatched
        // simultaneously. handleToolCall has its own try/catch; errors are
        // returned to the subprocess as tool_error messages.
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

    this.onUpdate?.({
      content: [{ type: "text", text: formatCallLabel(msg.tool, msg.params, this.toolCallCount) }],
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Format a compact one-line label for a tool call update.
 * Renders the first 1–2 params as key="value" pairs so the user can see
 * what's being invoked inside the ptc black box.
 *
 * Examples:
 *   → read(path="src/index.ts") #1
 *   → bash(command="git log --oneline -5") #2
 *   → grep(pattern="TODO", path="src/") #3
 *   → dev_tools(action="diagnostics", path="/abs/f.ts") #4  +1
 */
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
