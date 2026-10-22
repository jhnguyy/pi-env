import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const LOCK_NAME = "pi-env-heavyweight-operation.lock";
const OWNER_FILE = "owner.json";

export function gitCommonDir(cwd = process.cwd(), { allowMissing = false } = {}) {
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, LC_ALL: "C" },
    }).trim();
    return isAbsolute(commonDir) ? commonDir : resolve(cwd, commonDir);
  } catch (error) {
    if (allowMissing && error.status === 128 && error.stderr?.includes("not a git repository")) {
      return undefined;
    }
    throw error;
  }
}

export function heavyweightLockTimeoutMs(env = process.env) {
  const value = Number(env.PI_ENV_HEAVYWEIGHT_LOCK_TIMEOUT_MS ?? 10 * 60_000);
  return Number.isFinite(value) && value >= 0 ? value : 10 * 60_000;
}

async function readOwner(lockPath) {
  try {
    return JSON.parse(await readFile(resolve(lockPath, OWNER_FILE), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function pidIsAlive(pid) {
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

function lockSettings({
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
  signal,
  onWait,
} = {}) {
  return {
    commonDir,
    timeoutMs,
    retryMs,
    env,
    pid,
    token,
    now,
    nowMs,
    isPidAlive,
    writeOwnerFile,
    signal,
    onWait,
  };
}

async function tryCreateLease(lockPath, { token, pid, now, writeOwnerFile }) {
  try {
    await mkdir(lockPath, { mode: 0o700 });
    try {
      await writeOwnerFile(lockPath, { token, pid, acquiredAt: now() });
    } catch (error) {
      await rm(lockPath, { recursive: true, force: true });
      throw error;
    }
    return makeLease(lockPath, token, false);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return undefined;
  }
}

async function recoverStaleLease(lockPath, token, isPidAlive) {
  const recoveryPath = `${lockPath}.recovery`;
  try {
    await mkdir(recoveryPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return false;
  }
  try {
    // Another recoverer may already have replaced the observed owner with a live lease.
    const owner = await readOwner(lockPath);
    if (!owner || (await isPidAlive(owner.pid))) return false;
    const stalePath = `${lockPath}.stale-${token}`;
    try {
      await rename(lockPath, stalePath);
      await rm(stalePath, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "EEXIST") throw error;
      return false;
    }
  } finally {
    // An interrupted recoverer leaves its guard for conservative manual recovery.
    await rm(recoveryPath, { recursive: true, force: true });
  }
}

/** Acquire the lock in Git's common directory so sibling worktrees coordinate. */
export async function acquireHeavyweightLock(options) {
  const settings = lockSettings(options);
  const { commonDir, env, token, timeoutMs, nowMs, isPidAlive, signal, onWait, retryMs } = settings;
  const lockPath = resolve(commonDir, LOCK_NAME);
  const inheritedToken = env.PI_ENV_HEAVYWEIGHT_LOCK_TOKEN;
  const deadline = nowMs() + timeoutMs;
  let reportedWaiting = false;

  for (;;) {
    signal?.throwIfAborted();
    const created = await tryCreateLease(lockPath, settings);
    if (created) return created;

    const owner = await readOwner(lockPath);
    if (inheritedToken && owner?.token === inheritedToken) {
      return makeLease(lockPath, inheritedToken, true);
    }

    // Recover only a published owner whose process is gone. A live creator may
    // have made the directory but not yet atomically published owner.json, so a
    // genuinely ownerless directory is left in place for manual/conservative
    // recovery instead of being stolen by time.
    if (
      owner &&
      !(await isPidAlive(owner.pid)) &&
      (await recoverStaleLease(lockPath, token, isPidAlive))
    )
      continue;

    if (nowMs() >= deadline) {
      const holder = owner ? ` (held by pid ${owner.pid})` : "";
      throw new Error(`Timed out waiting for heavyweight-operation lock${holder}.`);
    }
    if (!reportedWaiting) {
      reportedWaiting = true;
      onWait?.(owner);
    }
    await sleep(retryMs, undefined, { signal });
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
