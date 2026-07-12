import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireHeavyweightLock, heavyweightLockName, withHeavyweightLock } from "../heavyweight-lock.mjs";

const temporaryDirs = [];

async function commonDir() {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-env-lock-"));
  temporaryDirs.push(directory);
  return directory;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("heavyweight lock", () => {
  it("times out while a separate process owns the lock", async () => {
    const directory = await commonDir();
    const child = spawn("scripts/node-run.sh", ["scripts/__tests__/lock-holder.mjs", directory], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const childClosed = new Promise((resolveClose) => child.once("close", resolveClose));
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    await new Promise((resolveReady, rejectReady) => {
      child.stdout?.once("data", () => resolveReady());
      child.once("error", rejectReady);
      child.once("close", (code) => rejectReady(new Error(`lock holder exited before acquiring the lock (${code}): ${stderr}`)));
    });

    await expect(acquireHeavyweightLock({ commonDir: directory, timeoutMs: 20, retryMs: 5 }))
      .rejects.toThrow("Timed out waiting");
    await childClosed;
  });

  it("recovers a lock whose owner PID is stale", async () => {
    const directory = await commonDir();
    const lockPath = resolve(directory, heavyweightLockName);
    await mkdir(lockPath);
    await writeFile(resolve(lockPath, "owner.json"), JSON.stringify({ token: "dead", pid: 999_999_999, acquiredAt: "now" }));

    const lease = await acquireHeavyweightLock({ commonDir: directory, isPidAlive: () => false });
    expect(JSON.parse(await readFile(resolve(lockPath, "owner.json"), "utf8")).token).toBe(lease.token);
    await lease.release();
  });

  it("does not recover an ownerless directory by age", async () => {
    const directory = await commonDir();
    const lockPath = resolve(directory, heavyweightLockName);
    await mkdir(lockPath);

    await expect(acquireHeavyweightLock({
      commonDir: directory, timeoutMs: 0, nowMs: () => 100,
    })).rejects.toThrow("Timed out waiting");
  });

  it("does not steal from a live creator delayed before owner publication", async () => {
    const directory = await commonDir();
    let publishOwner;
    const delayed = acquireHeavyweightLock({
      commonDir: directory,
      token: "creator",
      writeOwnerFile: (lockPath, owner) => new Promise((resolveWrite, rejectWrite) => {
        publishOwner = () => writeFile(resolve(lockPath, "owner.json"), JSON.stringify(owner)).then(resolveWrite, rejectWrite);
      }),
    });

    while (publishOwner === undefined) await new Promise((resolveReady) => setTimeout(resolveReady, 1));
    await expect(acquireHeavyweightLock({ commonDir: directory, timeoutMs: 0, nowMs: () => 100 }))
      .rejects.toThrow("Timed out waiting");
    publishOwner();
    const lease = await delayed;
    expect(lease.token).toBe("creator");
    await lease.release();
  });

  it("recovers an ownerless directory left when publishing its owner fails", async () => {
    const directory = await commonDir();
    await expect(acquireHeavyweightLock({
      commonDir: directory,
      writeOwnerFile: async () => { throw new Error("owner write failed"); },
    })).rejects.toThrow("owner write failed");

    const lease = await acquireHeavyweightLock({ commonDir: directory });
    await lease.release();
  });

  it("cleans up when the protected operation throws", async () => {
    const directory = await commonDir();
    await expect(withHeavyweightLock(async () => { throw new Error("boom"); }, { commonDir: directory })).rejects.toThrow("boom");
    expect(await exists(resolve(directory, heavyweightLockName))).toBe(false);
  });

  it("allows a child carrying the owner token to reenter without releasing", async () => {
    const directory = await commonDir();
    const outer = await acquireHeavyweightLock({ commonDir: directory, token: "owner-token" });
    const inner = await acquireHeavyweightLock({
      commonDir: directory,
      env: { PI_ENV_HEAVYWEIGHT_LOCK_TOKEN: outer.token },
      timeoutMs: 0,
    });
    expect(inner.inherited).toBe(true);
    await inner.release();
    expect(await exists(resolve(directory, heavyweightLockName))).toBe(true);
    await outer.release();
  });
});
