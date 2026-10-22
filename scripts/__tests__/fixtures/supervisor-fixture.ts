import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = process.cwd();

function readFixturePid(path: string): number {
  const record = readFileSync(path, "utf8");
  const pid = Number(record);
  if (
    !/^[1-9][0-9]*\n$/.test(record) ||
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    pid === process.pid
  ) {
    throw new Error("Invalid fixture PID; refusing to signal it");
  }
  return pid;
}

export function processTreeFixture(script = "supervised-process-tree.ts") {
  const cleanup = new DisposableStack();
  const directory = mkdtempSync(join(tmpdir(), "pi-supervised-tree-"));
  cleanup.defer(() => rmSync(directory, { recursive: true, force: true }));
  const pidFile = join(directory, "child-pid");
  const kill = () => {
    const groupFile = `${pidFile}.parent`;
    if (!existsSync(groupFile)) return;
    const groupId = readFixturePid(groupFile);
    try {
      process.kill(process.platform === "win32" ? groupId : -groupId, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  cleanup.defer(kill);
  return {
    pidFile,
    args: [join(import.meta.dirname, script), pidFile],
    pid: () => readFixturePid(pidFile),
    kill,
    [Symbol.dispose]: () => cleanup.dispose(),
  };
}

type ProcessTree = ReturnType<typeof processTreeFixture>;

export function startSupervisor(
  args: string[],
  {
    cwd = repo,
    env = {},
    tree,
  }: { cwd?: string; env?: NodeJS.ProcessEnv; tree?: ProcessTree } = {},
) {
  const child = spawn(
    join(repo, "scripts/node-run.sh"),
    [join(repo, "scripts/run-supervised-node.mjs"), ...args],
    {
      cwd,
      env: { ...process.env, PI_ENV_REPO: repo, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const output = { stdout: "", stderr: "" };
  const changed = new EventEmitter();
  const cleanupErrors: unknown[] = [];
  let watchdogFired = false;
  let settled = false;
  let error: Error | undefined;
  const attempt = (operation: () => unknown) => {
    try {
      operation();
    } catch (cause) {
      cleanupErrors.push(cause);
    }
  };
  const cleanWorkload = () => attempt(() => tree?.kill());
  const force = () => {
    attempt(() => child.kill("SIGKILL"));
    cleanWorkload();
    // A leaked workload must not keep the supervisor's close event pending.
    for (const stream of [child.stdin, child.stdout, child.stderr]) attempt(() => stream.destroy());
  };
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream].setEncoding("utf8").on("data", (chunk: string) => {
      output[stream] += chunk;
      changed.emit("output");
    });
  }
  child.once("error", (cause) => {
    error = cause;
  });
  // Do not hide production cleanup failures after a normal supervisor exit.
  child.once("exit", (_code, signal) => {
    if (signal || watchdogFired) cleanWorkload();
  });
  const watchdog = setTimeout(() => {
    watchdogFired = true;
    child.kill("SIGTERM");
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
      reject(new Error(`Supervisor did not close after escalation: ${output.stderr}`));
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
            `Supervisor exited before output ${JSON.stringify(text)}: ${JSON.stringify(result)}`,
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
          attempt(() => child.kill("SIGTERM"));
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
      if (failures.length) throw new AggregateError(failures, "Supervisor fixture cleanup failed");
    },
  };
}
