#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import lockfile from "proper-lockfile";
import type { CoordinatorRecord } from "./contracts.js";
import { ensureCoordinator, renderRestoreSummary } from "./coordinator.js";
import { createTmuxSessionHost } from "./host.js";
import { RuntimeMethod, runtimeRequest, type RestoreSummary } from "./runtime-bus.js";
import { resolveRuntimePaths, workspaceId, type RuntimePaths } from "./runtime-path.js";
import { SessionCatalog, sessionCatalogLayer, type SessionCatalogShape } from "./storage.js";

const env = process.env;
const required = (name: string): string => {
  const value = env[name];
  if (!value) throw new Error(`pi-env: ${name} is required for pi --start`);
  return value;
};
const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
const exec = (command: string, args: string[]) =>
  new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });

async function probeCoordinator(
  paths: RuntimePaths,
  id: string,
  coordinator: CoordinatorRecord,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const alive = await Effect.runPromise(
      runtimeRequest<{ alive: boolean }>({
        socketPath: paths.socketPath,
        workspaceId: id,
        coordinatorSessionId: coordinator.sessionId,
        method: RuntimeMethod.Ping,
        timeoutMs: 1_000,
      }),
    ).then(
      (result) => result.alive,
      () => false,
    );
    if (alive) return true;
  }
  return false;
}

async function hasLiveClaim(
  paths: RuntimePaths,
  id: string,
  coordinator: CoordinatorRecord,
): Promise<boolean> {
  try {
    const claim = JSON.parse(await readFile(paths.claimPath, "utf8")) as {
      workspaceId: string;
      coordinatorSessionId: string;
      pid: number;
      createdAt: number;
    };
    return (
      claim.workspaceId === id &&
      claim.coordinatorSessionId === coordinator.sessionId &&
      processAlive(claim.pid)
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertCoordinatorOffline(
  paths: RuntimePaths,
  id: string,
  coordinator: CoordinatorRecord,
  paneId: string,
): Promise<void> {
  try {
    const metadata = JSON.parse(await readFile(paths.metadataPath, "utf8")) as {
      workspaceId?: string;
      coordinatorSessionId?: string;
      pid?: number;
    };
    const matchingProcess =
      metadata.workspaceId === id &&
      metadata.coordinatorSessionId === coordinator.sessionId &&
      typeof metadata.pid === "number" &&
      processAlive(metadata.pid);
    if (matchingProcess) {
      throw new Error(
        `CoordinatorUnresponsive: ${coordinator.name} process ${metadata.pid} is still alive at ${paths.socketPath}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const currentWindow = await Effect.runPromise(createTmuxSessionHost(exec).inspectCurrent(paneId));
  const coordinatorWindows = currentWindow.bindings.filter(
    (binding) => binding.sessionId === coordinator.sessionId,
  );
  if (coordinatorWindows.length > 0) {
    throw new Error(
      `CoordinatorUnresponsive: ${coordinator.name} is bound to ${coordinatorWindows.map((item) => item.windowId).join(", ")} at ${paths.socketPath}`,
    );
  }
}

async function removeOwnedSocket(paths: RuntimePaths): Promise<void> {
  try {
    const before = await lstat(paths.socketPath);
    if (!before.isSocket() || before.isSymbolicLink() || before.uid !== process.getuid?.()) {
      throw new Error("stale runtime path is not an owned socket");
    }
    const after = await lstat(paths.socketPath);
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error("runtime socket changed during stale cleanup");
    }
    await unlink(paths.socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function removeFileIfPresent(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

type StartSelection = {
  readonly active: boolean;
  readonly coordinator: CoordinatorRecord;
  readonly launchId: string;
};

async function selectCoordinator(options: {
  catalog: SessionCatalogShape;
  canonicalCwd: string;
  manifestPath: string;
  paths: RuntimePaths;
  workspaceId: string;
  paneId: string;
}): Promise<StartSelection> {
  await mkdir(dirname(options.manifestPath), { recursive: true });
  const release = await lockfile.lock(`${options.manifestPath}.start`, {
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: { retries: 20, factor: 1, minTimeout: 100, maxTimeout: 100, randomize: false },
  });
  const launchId = randomUUID();
  try {
    const current = await Effect.runPromise(options.catalog.read(options.canonicalCwd));
    const coordinator = await Effect.runPromise(
      ensureCoordinator({
        catalog: options.catalog,
        cwd: options.canonicalCwd,
        entropy: randomInt,
      }),
    );
    const active = current?.coordinator
      ? await probeCoordinator(options.paths, options.workspaceId, coordinator)
      : false;
    if (active) return { active, coordinator, launchId };
    if (current?.coordinator) {
      if (await hasLiveClaim(options.paths, options.workspaceId, coordinator)) {
        throw new Error("WorkspaceStartInProgress: the coordinator is still starting");
      }
      await assertCoordinatorOffline(
        options.paths,
        options.workspaceId,
        coordinator,
        options.paneId,
      );
    }
    if (coordinator.persistence.state === "materialized") {
      await access(coordinator.persistence.sessionFile);
    }
    await removeOwnedSocket(options.paths);
    await removeFileIfPresent(options.paths.metadataPath);
    await removeFileIfPresent(options.paths.claimPath);
    await writeFile(
      options.paths.claimPath,
      `${JSON.stringify({
        version: 1,
        workspaceId: options.workspaceId,
        coordinatorSessionId: coordinator.sessionId,
        launchId,
        pid: process.pid,
        createdAt: Date.now(),
      })}\n`,
      { mode: 0o600, flag: "wx" },
    );
    return { active: false, coordinator, launchId };
  } finally {
    await release();
  }
}

async function reconcileActive(
  selection: StartSelection,
  paths: RuntimePaths,
  id: string,
): Promise<void> {
  const summary = await Effect.runPromise(
    runtimeRequest<RestoreSummary>({
      socketPath: paths.socketPath,
      workspaceId: id,
      coordinatorSessionId: selection.coordinator.sessionId,
      method: RuntimeMethod.Reconcile,
      idempotencyKey: selection.launchId,
      timeoutMs: 35_000,
    }),
  );
  console.log(renderRestoreSummary(summary));
  if (summary.outcomes.some((item) => item.state === "failed" || item.state === "timed-out")) {
    process.exitCode = 1;
  }
}

function launchCoordinator(
  selection: StartSelection,
  nodeBin: string,
  piEntry: string,
  extensionPath: string,
  wrapperPath: string,
  id: string,
): never {
  const coordinator = selection.coordinator;
  const sessionArgs =
    coordinator.persistence.state === "materialized"
      ? ["--session", coordinator.persistence.sessionFile]
      : ["--session-id", coordinator.sessionId, "--name", coordinator.name];
  process.execve!(nodeBin, [nodeBin, piEntry, ...sessionArgs, "--extension", extensionPath], {
    ...env,
    PI_ENV_SESSION_MANAGER_BYPASS: "1",
    PI_ENV_SESSION_MANAGER_EXPECTED: "1",
    PI_ENV_SESSION_MANAGER_ROLE: "coordinator",
    PI_ENV_SESSION_MANAGER_WORKSPACE_ID: id,
    PI_ENV_SESSION_MANAGER_EXPECTED_SESSION_ID: coordinator.sessionId,
    PI_ENV_SESSION_MANAGER_LAUNCH_ID: selection.launchId,
    PI_ENV_SESSION_MANAGER_EXTENSION: extensionPath,
    PI_ENV_PI_WRAPPER: wrapperPath,
  });
  throw new Error("process.execve returned unexpectedly");
}

async function main(): Promise<void> {
  if (typeof process.execve !== "function") {
    throw new Error("pi-env: configured Node does not expose process.execve()");
  }
  const nodeBin = required("PI_ENV_NODE_BIN");
  const piEntry = required("PI_ENV_REAL_PI_ENTRY");
  const wrapperPath = required("PI_ENV_PI_WRAPPER");
  const extensionPath = required("PI_ENV_SESSION_MANAGER_EXTENSION");
  const paneId = required("TMUX_PANE");
  await Promise.all([access(nodeBin), access(piEntry), access(wrapperPath), access(extensionPath)]);
  const agentDir = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const catalog = await Effect.runPromise(
    SessionCatalog.pipe(Effect.provide(sessionCatalogLayer(agentDir))),
  );
  const identity = await Effect.runPromise(catalog.identity(process.cwd()));
  const id = workspaceId(identity.canonicalCwd);
  const paths = await Effect.runPromise(resolveRuntimePaths(identity.canonicalCwd));
  const selection = await selectCoordinator({
    catalog,
    canonicalCwd: identity.canonicalCwd,
    manifestPath: identity.manifestPath,
    paths,
    workspaceId: id,
    paneId,
  });
  if (selection.active) return reconcileActive(selection, paths, id);
  return launchCoordinator(selection, nodeBin, piEntry, extensionPath, wrapperPath, id);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
