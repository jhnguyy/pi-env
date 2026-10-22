import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { opendirSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

interface ProcessIdentity {
  pid: number;
  parent: number;
  started: string;
}

function identity(pid: number): ProcessIdentity | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    return { pid, parent: Number(fields[1]), started: fields[19] };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
}

// Failure-time insurance cannot discover already orphaned or subsequently spawned work.
function descendantSnapshot(root: number, failures: unknown[]): ProcessIdentity[] {
  if (process.platform !== "linux") return [];
  const children = new Map<number, ProcessIdentity[]>();
  const deadline = performance.now() + 1_000;
  const directory = opendirSync("/proc");
  let scanned = 0;
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      if (performance.now() > deadline || scanned >= 4_096) {
        failures.push(new Error("Descendant snapshot exceeded its discovery budget"));
        break;
      }
      if (!/^[1-9][0-9]*$/.test(entry.name)) continue;
      scanned++;
      try {
        const record = identity(Number(entry.name));
        if (record) {
          const siblings = children.get(record.parent);
          if (siblings) siblings.push(record);
          else children.set(record.parent, [record]);
        }
      } catch (error) {
        failures.push(error);
      }
    }
  } finally {
    try {
      directory.closeSync();
    } catch (error) {
      failures.push(error);
    }
  }
  const descendants: ProcessIdentity[] = [];
  const pending = [root];
  const visited = new Set(pending);
  for (let index = 0; index < pending.length; index++) {
    for (const record of children.get(pending[index]) ?? []) {
      if (visited.has(record.pid)) continue;
      visited.add(record.pid);
      pending.push(record.pid);
      descendants.push(record);
    }
  }
  return descendants;
}

export function startChild(
  command: string,
  args: string[],
  {
    cwd = process.cwd(),
    env = {},
    cleanupWorkload,
  }: { cwd?: string; env?: NodeJS.ProcessEnv; cleanupWorkload?: () => void } = {},
) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output = { stdout: "", stderr: "" };
  const changed = new EventEmitter();
  const cleanupErrors: unknown[] = [];
  let watchdogFired = false;
  let settled = false;
  let error: Error | undefined;
  let descendants: ProcessIdentity[] | undefined;
  const attempt = (operation: () => unknown) => {
    try {
      operation();
    } catch (cause) {
      cleanupErrors.push(cause);
    }
  };
  const captureDescendants = () => {
    if (descendants !== undefined) return;
    descendants = [];
    const pid = child.pid;
    if (pid)
      attempt(() => {
        descendants = descendantSnapshot(pid, cleanupErrors);
      });
  };
  const cleanWorkload = () => {
    for (const record of descendants ?? [])
      attempt(() => {
        if (record.pid !== process.pid && identity(record.pid)?.started === record.started) {
          try {
            process.kill(record.pid, "SIGKILL");
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
          }
        }
      });
    attempt(() => cleanupWorkload?.());
  };
  const terminate = () => {
    captureDescendants();
    attempt(() => child.kill("SIGTERM"));
  };
  const force = () => {
    captureDescendants();
    attempt(() => child.kill("SIGKILL"));
    cleanWorkload();
    for (const stream of [child.stdin, child.stdout, child.stderr]) attempt(() => stream.destroy());
  };
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream].setEncoding("utf8").on("data", (chunk: string) => {
      if (output[stream].length + chunk.length > 128 * 1_024) {
        error = new Error(`Child fixture ${stream} exceeded its capture budget`);
        force();
        return;
      }
      output[stream] += chunk;
      changed.emit("output");
    });
  }
  child.once("error", (cause) => {
    error = cause;
  });
  // Normal exits must leave production cleanup observable until assertions finish.
  child.once("exit", (_code, signal) => {
    if (signal || watchdogFired) cleanWorkload();
  });
  const watchdog = setTimeout(() => {
    watchdogFired = true;
    terminate();
  }, 10_000).unref();
  const escalation = setTimeout(() => {
    watchdogFired = true;
    force();
  }, 11_000).unref();
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    error: Error | undefined;
    watchdogFired: boolean;
  }>((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(new Error(`Child did not close after escalation: ${output.stderr}`));
    }, 12_000).unref();
    child.once("close", (code, signal) => {
      settled = true;
      clearTimeout(watchdog);
      clearTimeout(escalation);
      clearTimeout(deadline);
      resolve({ code, signal, ...output, error, watchdogFired });
    });
  });
  const waitForOutput = async (stream: "stdout" | "stderr", text: string) => {
    if (output[stream].includes(text)) return;
    let notify = () => {};
    const observed = new Promise<void>((resolve) => {
      notify = () => {
        if (output[stream].includes(text)) resolve();
      };
      changed.on("output", notify);
    });
    try {
      await Promise.race([
        observed,
        closed.then((result) => {
          throw new Error(
            `Child exited before output ${JSON.stringify(text)}: ${JSON.stringify(result)}`,
          );
        }),
      ]);
    } finally {
      changed.off("output", notify);
    }
  };
  return {
    child,
    closed,
    waitForOutput,
    async [Symbol.asyncDispose]() {
      const failures: unknown[] = [];
      try {
        if (!settled) {
          terminate();
          const forced = setTimeout(force, 1_000).unref();
          try {
            await closed;
          } finally {
            clearTimeout(forced);
          }
        }
      } catch (cause) {
        failures.push(cause);
      } finally {
        cleanWorkload();
      }
      failures.push(...cleanupErrors);
      if (failures.length) throw new AggregateError(failures, "Child fixture cleanup failed");
    },
  };
}
