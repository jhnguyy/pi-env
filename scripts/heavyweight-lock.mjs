import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const LOCK_NAME = "pi-env-heavyweight-operation.lock";
const OWNER_FILE = "owner.json";

export function gitCommonDir(cwd = process.cwd()) {
  const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
  }).trim();
  return isAbsolute(commonDir) ? commonDir : resolve(cwd, commonDir);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function readOwner(lockPath) {
  try {
    return JSON.parse(await readFile(resolve(lockPath, OWNER_FILE), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function writeOwner(lockPath, owner) {
  const ownerPath = resolve(lockPath, OWNER_FILE);
  const temporaryPath = `${ownerPath}.${owner.token}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  await rename(temporaryPath, ownerPath);
}

/**
 * Acquire the repository-wide heavyweight-operation lock. The lock lives in
 * Git's common directory, so sibling worktrees coordinate with each other.
 */
export async function acquireHeavyweightLock({
  cwd = process.cwd(),
  commonDir = gitCommonDir(cwd),
  timeoutMs = 10 * 60_000,
  retryMs = 50,
  env = process.env,
  pid = process.pid,
  token = randomUUID(),
  now = () => new Date().toISOString(),
  nowMs = Date.now,
  isPidAlive = pidIsAlive,
  writeOwnerFile = writeOwner,
} = {}) {
  const lockPath = resolve(commonDir, LOCK_NAME);
  const inheritedToken = env.PI_ENV_HEAVYWEIGHT_LOCK_TOKEN;
  const deadline = nowMs() + timeoutMs;

  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const owner = { token, pid, acquiredAt: now() };
      try {
        await writeOwnerFile(lockPath, owner);
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      return makeLease(lockPath, token, false);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    const owner = await readOwner(lockPath);
    if (inheritedToken && owner?.token === inheritedToken) {
      return makeLease(lockPath, inheritedToken, true);
    }

    // Recover only a published owner whose process is gone. A live creator may
    // have made the directory but not yet atomically published owner.json, so a
    // genuinely ownerless directory is left in place for manual/conservative
    // recovery instead of being stolen by time.
    if (owner && !isPidAlive(owner.pid)) {
      const stalePath = `${lockPath}.stale-${token}`;
      try {
        await rename(lockPath, stalePath);
        await rm(stalePath, { recursive: true, force: true });
        continue;
      } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "EEXIST") throw error;
      }
    }

    if (nowMs() >= deadline) {
      const holder = owner ? ` (held by pid ${owner.pid})` : "";
      throw new Error(`Timed out waiting for heavyweight-operation lock${holder}.`);
    }
    await sleep(retryMs);
  }
}

function makeLease(lockPath, token, inherited) {
  let released = false;
  return {
    lockPath,
    token,
    inherited,
    async release() {
      if (released || inherited) return;
      released = true;
      const owner = await readOwner(lockPath);
      // Do not delete a lock that was recovered and acquired by somebody else.
      if (owner?.token === token) await rm(lockPath, { recursive: true, force: true });
    },
  };
}

export async function withHeavyweightLock(operation, options) {
  const lease = await acquireHeavyweightLock(options);
  try {
    return await operation(lease);
  } finally {
    await lease.release();
  }
}

export const heavyweightLockName = LOCK_NAME;
