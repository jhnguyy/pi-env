import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as SupervisorFixture from "./fixtures/supervisor-fixture.ts";

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

// Native process startup and kernel cleanup need an integration budget, not a speed assertion.
describe("supervised Node command runner", { timeout: 15_000 }, () => {
  it("preserves the child command exit status", async () => {
    await using runner = SupervisorFixture.startSupervisor(["-e", "process.exit(7)"]);
    const result = await runner.closed;
    expect(result.error, result.stderr).toBeUndefined();
    expect(result).toMatchObject({ code: 7, signal: null, watchdogFired: false });
  });

  it.runIf(process.platform !== "win32")("preserves the child signal exit status", async () => {
    await using runner = SupervisorFixture.startSupervisor([
      "-e",
      "process.kill(process.pid, 'SIGTERM')",
    ]);
    const result = await runner.closed;
    expect(result.error, result.stderr).toBeUndefined();
    expect(result).toMatchObject({ code: 143, signal: null, watchdogFired: false });
  });

  it.runIf(process.platform !== "win32")(
    "cleans descendants when its caller sends SIGTERM",
    async () => {
      using tree = SupervisorFixture.processTreeFixture();
      await using runner = SupervisorFixture.startSupervisor(tree.args, {
        env: { PI_ENV_TEST_KILL_GRACE_MS: "50" },
        tree,
      });
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
      using tree = SupervisorFixture.processTreeFixture();
      await using runner = SupervisorFixture.startSupervisor(tree.args, {
        env: { PI_ENV_TEST_TIMEOUT_MS: "3000", PI_ENV_TEST_KILL_GRACE_MS: "50" },
        tree,
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
