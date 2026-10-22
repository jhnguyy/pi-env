import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { acquireHeavyweightLock, gitCommonDir } from "../heavyweight-lock.mjs";

const execute = promisify(execFile);
const repo = process.cwd();
const runner = join(repo, "scripts/run-supervised-node.mjs");
const workload = join(import.meta.dirname, "fixtures/heavyweight-workload.ts");
const node = process.env.PI_ENV_NODE_BIN ?? process.execPath;
const manifest = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
const env = {
  ...process.env,
  PI_ENV_REPO: repo,
  PI_ENV_HEAVYWEIGHT_LOCK_TOKEN: "",
  PI_ENV_HEAVYWEIGHT_LOCK_TIMEOUT_MS: "0",
};
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    stdio: "pipe",
  });

const it = test.extend({
  workspace: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), "heavyweight-entrypoints-"));
    try {
      // Use the shipped commands and installed tools with synthetic Git history.
      const scripts = Object.fromEntries(
        ["typecheck", "lint:type", "test:vitest"].map((name) => [
          name,
          manifest.scripts[name].replace(
            /\b(?:scripts|node_modules)\/[^\s]+/g,
            (path) => `'${join(repo, path).replaceAll("'", "'\\''")}'`,
          ),
        ]),
      );
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ type: "module", engines: manifest.engines, scripts }),
      );
      git(root, "init", "-b", "main");
      git(root, "add", ".");
      git(root, "commit", "-m", "baseline");
      const sibling = join(root, "sibling worktree");
      git(root, "worktree", "add", "-b", "sibling", sibling);
      await use({ root, sibling, commonDir: gitCommonDir(root) });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
});

async function start(cwd, extraEnv = {}, args = [workload]) {
  const child = spawn(node, [runner, "--heavyweight", ...args], {
    cwd,
    env: { ...env, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let ready;
  const started = new Promise((resolve) => {
    ready = resolve;
  });
  let notifyWaiting;
  const waiting = new Promise((resolve) => {
    notifyWaiting = resolve;
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (stdout.includes("ready\n")) ready();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (stderr.includes("Waiting for heavyweight-operation lock")) notifyWaiting();
  });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
  closed.then(
    () => clearTimeout(watchdog),
    () => clearTimeout(watchdog),
  );
  return {
    child,
    closed,
    ready: () =>
      Promise.race([
        started,
        closed.then((result) => {
          throw new Error(`Exited before readiness: ${JSON.stringify(result)}`);
        }),
      ]),
    waiting: () =>
      Promise.race([
        waiting,
        closed.then((result) => {
          throw new Error(`Exited before waiting: ${JSON.stringify(result)}`);
        }),
      ]),
    async [Symbol.asyncDispose]() {
      child.kill("SIGTERM");
      await closed;
    },
  };
}

for (const name of ["typecheck", "lint:type", "test:vitest"]) {
  it(`${name} waits for a sibling worktree's lease before launching its real tool`, async ({
    workspace,
  }) => {
    const lease = await acquireHeavyweightLock({ cwd: workspace.root, env });
    try {
      await expect(
        execute("nub", ["run", name, "--help"], { cwd: workspace.sibling, env, timeout: 12_000 }),
      ).rejects.toMatchObject({
        code: 1,
        stdout: "",
        stderr: expect.stringContaining("Timed out waiting for heavyweight-operation lock"),
      });
    } finally {
      await lease.release();
    }
    const result = await execute("nub", ["run", name, "--help"], {
      cwd: workspace.sibling,
      env,
      timeout: 12_000,
    });
    expect(result.stdout.trim()).not.toBe("");
  });
}

it("holds its lease until exit and preserves the command status", async ({ workspace }) => {
  await using command = await start(workspace.root);
  await command.ready();
  await expect(
    acquireHeavyweightLock({ cwd: workspace.sibling, env, timeoutMs: 0 }),
  ).rejects.toThrow("Timed out waiting");
  command.child.stdin.end("finish\n");
  expect(await command.closed).toMatchObject({ code: 7, signal: null });
  const next = await acquireHeavyweightLock({ cwd: workspace.sibling, env, timeoutMs: 0 });
  await next.release();
});

it("reenters an inherited lease without releasing its owner", async ({ workspace }) => {
  const outer = await acquireHeavyweightLock({ cwd: workspace.root, env });
  try {
    await using command = await start(workspace.sibling, {
      PI_ENV_HEAVYWEIGHT_LOCK_TOKEN: outer.token,
    });
    await command.ready();
    command.child.stdin.end("finish\n");
    expect(await command.closed).toMatchObject({ code: 7 });
    expect(JSON.parse(await readFile(join(outer.lockPath, "owner.json"), "utf8")).token).toBe(
      outer.token,
    );
  } finally {
    await outer.release();
  }
});

it.runIf(process.platform !== "win32")(
  "releases its lease on SIGTERM and permits the next command",
  async ({ workspace }) => {
    await using command = await start(workspace.root);
    await command.ready();
    command.child.kill("SIGTERM");
    expect(await command.closed).toMatchObject({ code: 143, signal: null });
    const next = await acquireHeavyweightLock({ cwd: workspace.sibling, env, timeoutMs: 0 });
    await next.release();
  },
);

it("starts a queued command only after its sibling releases the lease", async ({ workspace }) => {
  const outer = await acquireHeavyweightLock({ cwd: workspace.root, env });
  try {
    await using command = await start(workspace.sibling, {
      PI_ENV_HEAVYWEIGHT_LOCK_TIMEOUT_MS: "10000",
    });
    await command.waiting();
    expect(JSON.parse(await readFile(join(outer.lockPath, "owner.json"), "utf8")).token).toBe(
      outer.token,
    );
    await outer.release();
    await command.ready();
    command.child.stdin.end("finish\n");
    expect(await command.closed).toMatchObject({ code: 7 });
  } finally {
    await outer.release();
  }
});

it.runIf(process.platform !== "win32")(
  "cancels a waiter without starting work or releasing the owner's lease",
  async ({ workspace }) => {
    const outer = await acquireHeavyweightLock({ cwd: workspace.root, env });
    try {
      await using command = await start(workspace.sibling, {
        PI_ENV_HEAVYWEIGHT_LOCK_TIMEOUT_MS: "10000",
      });
      await command.waiting();
      command.child.kill("SIGTERM");
      expect(await command.closed).toMatchObject({ code: 143, stdout: "", signal: null });
      expect(JSON.parse(await readFile(join(outer.lockPath, "owner.json"), "utf8")).token).toBe(
        outer.token,
      );
    } finally {
      await outer.release();
    }
  },
);

it.runIf(process.platform !== "win32")(
  "recovers after a separate lease owner is killed",
  async ({ workspace }) => {
    const holder = spawn(
      node,
      [join(repo, "scripts/__tests__/lock-holder.mjs"), workspace.commonDir, "--hold"],
      {
        cwd: workspace.root,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const closed = once(holder, "close");
    try {
      await Promise.race([
        once(holder.stdout, "data"),
        closed.then(() => {
          throw new Error("Owner exited before locking");
        }),
      ]);
      holder.kill("SIGKILL");
      await closed;
      const ownerPath = join(workspace.commonDir, "pi-env-heavyweight-operation.lock/owner.json");
      expect(JSON.parse(await readFile(ownerPath, "utf8")).pid).toBe(holder.pid);
      await using command = await start(workspace.sibling);
      await command.ready();
      command.child.stdin.end("finish\n");
      expect(await command.closed).toMatchObject({ code: 7 });
    } finally {
      holder.kill("SIGKILL");
      await closed;
    }
  },
);

it("runs a source snapshot without Git metadata", async () => {
  // This directory is outside Git's search path, unlike an untracked subdirectory.
  const outside = await mkdtemp(join(tmpdir(), "heavyweight-snapshot-"));
  try {
    await using command = await start(outside);
    await command.ready();
    command.child.stdin.end("finish\n");
    expect(await command.closed).toMatchObject({ code: 7 });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
