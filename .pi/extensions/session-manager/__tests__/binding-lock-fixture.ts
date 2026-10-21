import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { terminateAndWait } from "../../../../src/process/platform.js";

const READY_TOKEN = Buffer.from("locked");
const STDERR_LIMIT_BYTES = 4096;

export function waitForBindingLockReady(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const stderr = Buffer.alloc(STDERR_LIMIT_BYTES);
    let stderrBytes = 0;
    let stderrTruncated = false;
    let tokenBytes = 0;
    let settled = false;
    const finish = (failure?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stdout?.resume();
      if (failure) {
        const diagnostic = stderr.subarray(0, stderrBytes).toString("utf8");
        reject(
          new Error(`${failure}; stderr: ${diagnostic}${stderrTruncated ? " [truncated]" : ""}`),
        );
      } else {
        resolve();
      }
    };
    const onStdout = (chunk: Buffer): void => {
      if (
        chunk.length > READY_TOKEN.length - tokenBytes ||
        !chunk.equals(READY_TOKEN.subarray(tokenBytes, tokenBytes + chunk.length))
      ) {
        finish("Invalid binding lock readiness token");
        return;
      }
      tokenBytes += chunk.length;
      if (tokenBytes === READY_TOKEN.length) finish();
    };
    const onStderr = (chunk: Buffer): void => {
      const copied = chunk.copy(stderr, stderrBytes, 0, STDERR_LIMIT_BYTES - stderrBytes);
      stderrBytes += copied;
      if (copied < chunk.length) stderrTruncated = true;
    };
    const onError = (error: Error): void =>
      finish(`Binding lock owner spawn/process error: ${error.message}`);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(`Binding lock owner exited before readiness (code=${code}, signal=${signal})`);
    };
    const onClose = (): void => {
      finish("Binding lock owner closed before readiness");
      child.off("error", onError);
      child.off("exit", onExit);
      child.stderr?.off("data", onStderr);
    };
    const timer = setTimeout(
      () => finish(`Binding lock readiness deadline exceeded (${timeoutMs}ms)`),
      timeoutMs,
    );
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.on("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

export function startBindingLockOwner(socket: string, readinessDeadline: number) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./binding-lock-child.ts", import.meta.url)), socket],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const ready = waitForBindingLockReady(child, Math.max(0, readinessDeadline - performance.now()));
  return {
    child,
    ready,
    closed,
    async stop() {
      try {
        await terminateAndWait(child);
      } finally {
        await closed;
      }
    },
  };
}
