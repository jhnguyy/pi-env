import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import * as HeavyweightLock from "../heavyweight-lock.mjs";
import * as ChildFixture from "./fixtures/child-process-fixture.ts";
import * as SupervisorFixture from "./fixtures/supervisor-fixture.ts";

const repo = process.cwd();
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
      await use({ root, sibling, commonDir: HeavyweightLock.gitCommonDir(root) });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
});

async function start(cwd, extraEnv = {}) {
  await using startup = new AsyncDisposableStack();
  const tree = startup.use(SupervisorFixture.processTreeFixture("heavyweight-workload.ts"));
  const command = startup.use(
    SupervisorFixture.startSupervisor(["--heavyweight", ...tree.args], {
      cwd,
      env: { ...env, ...extraEnv },
      tree,
    }),
  );
  const cleanup = startup.move();
  return {
    ...command,
    ready: () => command.waitForOutput("stdout", "ready\n"),
    waiting: () => command.waitForOutput("stderr", "Waiting for heavyweight-operation lock"),
    [Symbol.asyncDispose]: () => cleanup.disposeAsync(),
  };
}

for (const name of ["typecheck", "lint:type", "test:vitest"]) {
  it(`${name} rejects contention and launches its real tool after release`, async ({
    workspace,
  }) => {
    const lease = await HeavyweightLock.acquireHeavyweightLock({ cwd: workspace.root, env });
    try {
      await using blocked = ChildFixture.startChild("nub", ["run", name, "--help"], {
        cwd: workspace.sibling,
        env,
      });
      expect(await blocked.closed).toMatchObject({
        code: 1,
        stdout: "",
        error: undefined,
        watchdogFired: false,
        stderr: expect.stringContaining("Timed out waiting for heavyweight-operation lock"),
      });
    } finally {
      await lease.release();
    }
    await using launched = ChildFixture.startChild("nub", ["run", name, "--help"], {
      cwd: workspace.sibling,
      env,
    });
    const result = await launched.closed;
    expect(result).toMatchObject({ code: 0, error: undefined, watchdogFired: false });
    expect(result.stdout.trim()).not.toBe("");
  });
}

it("holds its lease until exit and preserves the command status", async ({ workspace }) => {
  await using command = await start(workspace.root);
  await command.ready();
  await expect(
    HeavyweightLock.acquireHeavyweightLock({ cwd: workspace.sibling, env, timeoutMs: 0 }),
  ).rejects.toThrow("Timed out waiting");
  command.child.stdin.end("finish\n");
  expect(await command.closed).toMatchObject({ code: 7, signal: null, watchdogFired: false });
  const next = await HeavyweightLock.acquireHeavyweightLock({
    cwd: workspace.sibling,
    env,
    timeoutMs: 0,
  });
  await next.release();
});

it("reenters an inherited lease without releasing its owner", async ({ workspace }) => {
  const outer = await HeavyweightLock.acquireHeavyweightLock({ cwd: workspace.root, env });
  try {
    await using command = await start(workspace.sibling, {
      PI_ENV_HEAVYWEIGHT_LOCK_TOKEN: outer.token,
    });
    await command.ready();
    command.child.stdin.end("finish\n");
    expect(await command.closed).toMatchObject({ code: 7, watchdogFired: false });
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
    expect(await command.closed).toMatchObject({ code: 143, signal: null, watchdogFired: false });
    const next = await HeavyweightLock.acquireHeavyweightLock({
      cwd: workspace.sibling,
      env,
      timeoutMs: 0,
    });
    await next.release();
  },
);

it("starts a queued command only after its sibling releases the lease", async ({ workspace }) => {
  const outer = await HeavyweightLock.acquireHeavyweightLock({ cwd: workspace.root, env });
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
    expect(await command.closed).toMatchObject({ code: 7, watchdogFired: false });
  } finally {
    await outer.release();
  }
});

it.runIf(process.platform !== "win32")(
  "cancels a waiter without starting work or releasing the owner's lease",
  async ({ workspace }) => {
    const outer = await HeavyweightLock.acquireHeavyweightLock({ cwd: workspace.root, env });
    try {
      await using command = await start(workspace.sibling, {
        PI_ENV_HEAVYWEIGHT_LOCK_TIMEOUT_MS: "10000",
      });
      await command.waiting();
      command.child.kill("SIGTERM");
      expect(await command.closed).toMatchObject({
        code: 143,
        stdout: "",
        signal: null,
        watchdogFired: false,
      });
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
    await using holder = ChildFixture.startChild(
      node,
      [join(repo, "scripts/__tests__/lock-holder.mjs"), workspace.commonDir, "--hold"],
      { cwd: workspace.root, env },
    );
    await holder.waitForOutput("stdout", "locked\n");
    holder.child.kill("SIGKILL");
    expect(await holder.closed).toMatchObject({ signal: "SIGKILL", watchdogFired: false });
    const ownerPath = join(workspace.commonDir, "pi-env-heavyweight-operation.lock/owner.json");
    expect(JSON.parse(await readFile(ownerPath, "utf8")).pid).toBe(holder.child.pid);
    await using command = await start(workspace.sibling);
    await command.ready();
    command.child.stdin.end("finish\n");
    expect(await command.closed).toMatchObject({ code: 7, watchdogFired: false });
  },
);

it("runs a source snapshot without Git metadata", async () => {
  // This directory is outside Git's search path, unlike an untracked subdirectory.
  const outside = await mkdtemp(join(tmpdir(), "heavyweight-snapshot-"));
  try {
    await using command = await start(outside);
    await command.ready();
    command.child.stdin.end("finish\n");
    expect(await command.closed).toMatchObject({ code: 7, watchdogFired: false });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
