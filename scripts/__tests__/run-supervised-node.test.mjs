import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
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

describe("supervised Node command runner", () => {
  it("owns one normalized Vitest command used by every portfolio", () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    expect(manifest.scripts["test:vitest"]).toBe(
      "scripts/node-run.sh scripts/run-supervised-node.mjs node_modules/vitest/vitest.mjs run --pool=threads",
    );
    for (const name of [
      "test:unit",
      "test:changed",
      "test:safe",
      "test:e2e",
      "test:e2e:real-workspace-canary",
    ]) {
      expect(manifest.scripts[name]).toContain("nub run test:vitest");
    }
  });

  it("preserves the child command exit status", () => {
    const result = spawnSync(
      "scripts/node-run.sh",
      ["scripts/run-supervised-node.mjs", "-e", "process.exit(7)"],
      { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(7);

    if (process.platform !== "win32") {
      const signalled = spawnSync(
        "scripts/node-run.sh",
        ["scripts/run-supervised-node.mjs", "-e", "process.kill(process.pid, 'SIGTERM')"],
        { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 },
      );
      expect(signalled.error).toBeUndefined();
      expect(signalled.status).toBe(143);
    }
  });

  it.runIf(process.platform !== "win32")(
    "cleans descendants when its caller sends SIGTERM",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "pi-supervised-signal-"));
      const childPidFile = join(directory, "child-pid");
      const parentScript = join(directory, "parent.mjs");
      const childCode = [
        "const fs=require('node:fs')",
        "process.on('SIGTERM',()=>{})",
        `fs.writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid))`,
        "setInterval(()=>{}, 1000)",
      ].join(";");
      writeFileSync(
        parentScript,
        `import { spawn } from "node:child_process";\nspawn(process.env.PI_ENV_NODE_BIN, ["-e", ${JSON.stringify(childCode)}], { stdio: "ignore" });\nsetInterval(() => {}, 1000);\n`,
      );

      const runner = spawn(
        "scripts/node-run.sh",
        ["scripts/run-supervised-node.mjs", parentScript],
        {
          cwd: process.cwd(),
          env: { ...process.env, PI_ENV_TEST_KILL_GRACE_MS: "50" },
          stdio: "ignore",
        },
      );
      const closed = new Promise((resolve) =>
        runner.once("close", (code, signal) => resolve({ code, signal })),
      );
      let childPid;
      try {
        await eventually(() => expect(existsSync(childPidFile)).toBe(true), 120);
        childPid = Number(readFileSync(childPidFile, "utf8"));
        runner.kill("SIGTERM");
        await expect(closed).resolves.toEqual({ code: 143, signal: null });
        await eventually(() => expect(isAlive(childPid)).toBe(false));
      } finally {
        if (runner.exitCode === null && runner.signalCode === null) runner.kill("SIGKILL");
        if (childPid && isAlive(childPid)) process.kill(childPid, "SIGKILL");
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "times out and removes a TERM-ignoring descendant",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "pi-supervised-node-"));
      const childPidFile = join(directory, "child-pid");
      const parentScript = join(directory, "parent.mjs");
      const childCode = [
        "const fs=require('node:fs')",
        "process.on('SIGTERM',()=>{})",
        `fs.writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid))`,
        "setInterval(()=>{}, 1000)",
      ].join(";");
      writeFileSync(
        parentScript,
        `import { spawn } from "node:child_process";\nspawn(process.env.PI_ENV_NODE_BIN, ["-e", ${JSON.stringify(childCode)}], { stdio: "ignore" });\nsetInterval(() => {}, 1000);\n`,
      );

      let childPid;
      try {
        const result = spawnSync(
          "scripts/node-run.sh",
          ["scripts/run-supervised-node.mjs", parentScript],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            env: {
              ...process.env,
              PI_ENV_TEST_TIMEOUT_MS: "750",
              PI_ENV_TEST_KILL_GRACE_MS: "50",
            },
            timeout: 5_000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(124);
        expect(result.stderr).toContain("Process timed out after 750ms");
        expect(existsSync(childPidFile)).toBe(true);
        childPid = Number(readFileSync(childPidFile, "utf8"));
        await eventually(() => expect(isAlive(childPid)).toBe(false));
      } finally {
        if (childPid && isAlive(childPid)) process.kill(childPid, "SIGKILL");
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
