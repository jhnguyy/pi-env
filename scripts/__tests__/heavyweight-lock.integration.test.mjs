import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import * as HeavyweightLock from "../heavyweight-lock.mjs";

const it = test.extend({
  directory: async ({}, use) => {
    const directory = await mkdtemp(resolve(tmpdir(), "pi-env-lock-"));
    try {
      await use(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
});

async function lockPathFor(commonDir) {
  const lease = await HeavyweightLock.acquireHeavyweightLock({ commonDir });
  await lease.release();
  return lease.lockPath;
}

it("does not recover an ownerless directory by age", async ({ directory }) => {
  const lockPath = await lockPathFor(directory);
  await mkdir(lockPath);
  await expect(
    HeavyweightLock.acquireHeavyweightLock({
      commonDir: directory,
      timeoutMs: 0,
      nowMs: () => 100,
    }),
  ).rejects.toThrow("Timed out waiting");
});

it("does not steal from a live creator delayed before owner publication", async ({ directory }) => {
  const publishing = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const delayed = HeavyweightLock.acquireHeavyweightLock({
    commonDir: directory,
    token: "creator",
    writeOwnerFile: async (lockPath, owner) => {
      publishing.resolve();
      await resume.promise;
      await writeFile(resolve(lockPath, "owner.json"), JSON.stringify(owner));
    },
  });
  try {
    await publishing.promise;
    await expect(
      HeavyweightLock.acquireHeavyweightLock({
        commonDir: directory,
        timeoutMs: 0,
        nowMs: () => 100,
      }),
    ).rejects.toThrow("Timed out waiting");
  } finally {
    resume.resolve();
    const lease = await delayed;
    await lease.release();
  }
});

it("removes an unpublished lease when publishing its owner fails", async ({ directory }) => {
  await expect(
    HeavyweightLock.acquireHeavyweightLock({
      commonDir: directory,
      writeOwnerFile: async () => {
        throw new Error("owner write failed");
      },
    }),
  ).rejects.toThrow("owner write failed");
  const lease = await HeavyweightLock.acquireHeavyweightLock({ commonDir: directory });
  await lease.release();
});

it("cleans up when the protected operation throws", async ({ directory }) => {
  const lockPath = await lockPathFor(directory);
  await expect(
    HeavyweightLock.withHeavyweightLock(
      async () => {
        throw new Error("boom");
      },
      {
        commonDir: directory,
      },
    ),
  ).rejects.toThrow("boom");
  await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not let a competing stale observation recover a newly acquired live lease", async ({
  directory,
}) => {
  const lockPath = await lockPathFor(directory);
  await mkdir(lockPath);
  await writeFile(
    resolve(lockPath, "owner.json"),
    JSON.stringify({ token: "dead", pid: 999_999_999 }),
  );
  const observed = Promise.withResolvers();
  const resume = Promise.withResolvers();
  let delayedLease;
  const delayed = HeavyweightLock.acquireHeavyweightLock({
    commonDir: directory,
    timeoutMs: 0,
    isPidAlive: async (pid) => {
      if (pid === 999_999_999) {
        observed.resolve();
        await resume.promise;
        return false;
      }
      return pid === process.pid;
    },
  }).then((lease) => {
    delayedLease = lease;
    return lease;
  });
  let current;
  try {
    await observed.promise;
    current = await HeavyweightLock.acquireHeavyweightLock({ commonDir: directory });
    resume.resolve();
    await expect(delayed).rejects.toThrow("Timed out waiting");
    expect(JSON.parse(await readFile(resolve(lockPath, "owner.json"), "utf8")).token).toBe(
      current.token,
    );
  } finally {
    resume.resolve();
    await delayed.catch(() => {});
    await delayedLease?.release();
    await current?.release();
  }
});

it("leaves an interrupted recovery guard in place rather than guessing ownership", async ({
  directory,
}) => {
  const lockPath = await lockPathFor(directory);
  await mkdir(lockPath);
  await writeFile(
    resolve(lockPath, "owner.json"),
    JSON.stringify({ token: "dead", pid: 999_999_999 }),
  );
  await mkdir(`${lockPath}.recovery`);
  await expect(
    HeavyweightLock.acquireHeavyweightLock({
      commonDir: directory,
      timeoutMs: 0,
    }),
  ).rejects.toThrow("Timed out waiting");
  expect(JSON.parse(await readFile(resolve(lockPath, "owner.json"), "utf8")).token).toBe("dead");
  expect((await stat(`${lockPath}.recovery`)).isDirectory()).toBe(true);
});
