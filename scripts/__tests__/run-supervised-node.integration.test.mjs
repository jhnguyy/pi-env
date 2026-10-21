import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function eventually(assertion, attempts = 40) {
  let lastError;
  for (let index = 0; index < attempts; index++) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

function startSupervisor(args, env = {}) {
  const child = spawn("scripts/node-run.sh", ["scripts/run-supervised-node.mjs", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let watchdogFired = false;
  let settled = false;
  const force = () => {
    child.kill("SIGKILL");
    // A leaked detached fixture parent must not keep the supervisor's close event pending.
    child.stderr.destroy();
  };
  const watchdog = setTimeout(() => {
    watchdogFired = true;
    child.kill("SIGTERM");
  }, 10_000).unref();
  const escalation = setTimeout(() => {
    watchdogFired = true;
    force();
  }, 11_000).unref();
  let stderr = "";
  let error;
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  child.once("error", (cause) => {
    error = cause;
  });
  const closed = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(new Error(`Supervisor did not close after escalation: ${stderr}`));
    }, 12_000).unref();
    child.once("close", (code, signal) => {
      settled = true;
      clearTimeout(watchdog);
      clearTimeout(escalation);
      clearTimeout(deadline);
      resolve({ code, signal, stderr, error, watchdogFired });
    });
  });
  return {
    child,
    closed,
    async [Symbol.asyncDispose]() {
      if (settled) return;
      child.kill("SIGTERM");
      const forced = setTimeout(force, 1_000).unref();
      try {
        await closed;
      } finally {
        clearTimeout(forced);
      }
    },
  };
}

function readFixturePid(path) {
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

function processTreeFixture() {
  const cleanup = new DisposableStack();
  const directory = mkdtempSync(join(tmpdir(), "pi-supervised-tree-"));
  cleanup.defer(() => rmSync(directory, { recursive: true, force: true }));
  const pidFile = join(directory, "child-pid");
  cleanup.defer(() => {
    const groupFile = `${pidFile}.parent`;
    if (!existsSync(groupFile)) return;
    const groupId = readFixturePid(groupFile);
    try {
      process.kill(-groupId, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  });
  return {
    pidFile,
    args: [join(import.meta.dirname, "fixtures/supervised-process-tree.ts"), pidFile],
    pid: () => readFixturePid(pidFile),
    [Symbol.dispose]: () => cleanup.dispose(),
  };
}

// Native process startup and kernel cleanup need an integration budget, not a speed assertion.
describe("supervised Node command runner", { timeout: 15_000 }, () => {
  it("preserves the child command exit status", async () => {
    await using runner = startSupervisor(["-e", "process.exit(7)"]);
    const result = await runner.closed;
    expect(result.error, result.stderr).toBeUndefined();
    expect(result).toMatchObject({ code: 7, signal: null, watchdogFired: false });
  });

  it.runIf(process.platform !== "win32")("preserves the child signal exit status", async () => {
    await using runner = startSupervisor(["-e", "process.kill(process.pid, 'SIGTERM')"]);
    const result = await runner.closed;
    expect(result.error, result.stderr).toBeUndefined();
    expect(result).toMatchObject({ code: 143, signal: null, watchdogFired: false });
  });

  it.runIf(process.platform !== "win32")(
    "cleans descendants when its caller sends SIGTERM",
    async () => {
      using tree = processTreeFixture();
      await using runner = startSupervisor(tree.args, { PI_ENV_TEST_KILL_GRACE_MS: "50" });
      await Promise.race([
        eventually(() => expect(tree.pid()).toBeGreaterThan(1), 240),
        runner.closed.then((result) => {
          throw new Error(
            `Supervisor exited before descendant readiness: ${JSON.stringify(result)}`,
          );
        }),
      ]);
      const pid = tree.pid();
      runner.child.kill("SIGTERM");
      await expect(runner.closed).resolves.toMatchObject({
        code: 143,
        signal: null,
        watchdogFired: false,
      });
      await eventually(() => expect(isAlive(pid)).toBe(false));
    },
  );

  it.runIf(process.platform !== "win32")(
    "times out and removes a TERM-ignoring descendant",
    async () => {
      using tree = processTreeFixture();
      await using runner = startSupervisor(tree.args, {
        PI_ENV_TEST_TIMEOUT_MS: "3000",
        PI_ENV_TEST_KILL_GRACE_MS: "50",
      });
      const result = await runner.closed;
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.code, result.stderr).toBe(124);
      expect(result.watchdogFired).toBe(false);
      expect(result.stderr).toContain("Process timed out after 3000ms");
      expect(existsSync(tree.pidFile)).toBe(true);
      await eventually(() => expect(isAlive(tree.pid())).toBe(false));
    },
  );
});
