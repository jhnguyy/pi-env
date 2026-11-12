import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { expect, it, onTestFinished, vi } from "vitest";
import * as TempDir from "../../src/testing/temp-dir.ts";
import { resolveNodeCommand, runProcess } from "../../src/process/platform.ts";
import { LspDaemon } from "../../extensions/dev-tools/daemon.ts";
import { LspClient } from "../../extensions/dev-tools/client.ts";
import { daemonPaths } from "../../extensions/dev-tools/paths.ts";
import { ControlledBackend } from "../../extensions/dev-tools/__tests__/controlled-backend.ts";
import { restartDaemon } from "../restart-lsp-daemon.mjs";

const script = fileURLToPath(new URL("../restart-lsp-daemon.mjs", import.meta.url));
const node = resolveNodeCommand();

it("leaves an unrelated live PID and stale artifacts untouched", async () => {
  const root = TempDir.forTestSync("lsp-restart-");
  const socket = join(root, "daemon.sock");
  const pid = join(root, "daemon.pid");
  const sentinel = spawn(node, ["-e", "process.stdin.pipe(process.stdout)"], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  onTestFinished(async () => {
    if (sentinel.exitCode === null && sentinel.signalCode === null) {
      const closed = once(sentinel, "close");
      sentinel.kill();
      await closed;
    }
  });
  writeFileSync(pid, String(sentinel.pid));
  writeFileSync(socket, "stale");
  const result = await Effect.runPromise(runProcess(node, [script, socket, pid]));
  expect(result.exitCode).toBe(0);
  const alive = once(sentinel.stdout, "data");
  sentinel.stdin.write("alive");
  expect(String((await alive)[0])).toBe("alive");
  expect(existsSync(pid)).toBe(true);
  expect(existsSync(socket)).toBe(true);
});

it.each(["completed", "timed out"])("keeps ownership until cleanup %s", async (mode) => {
  const root = TempDir.forTestSync("lsp-restart-drain-");
  const socket = join(root, "daemon.sock");
  const pid = join(root, "daemon.pid");
  let entered;
  let release;
  const cleaning = new Promise((resolve) => {
    entered = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const backend = new ControlledBackend(root);
  backend.onShutdown = async () => {
    entered();
    await held;
  };
  const daemon = new LspDaemon(socket, pid, 60_000, undefined, { backends: [backend] });
  onTestFinished(async () => {
    release();
    await daemon.shutdown();
  });
  await daemon.start();
  const outcome = restartDaemon(socket, pid, mode === "timed out" ? 300 : 5_000).then(
    () => undefined,
    (error) => error,
  );
  await cleaning;
  if (mode === "completed") {
    release();
    expect(await outcome).toBeUndefined();
  } else {
    expect(await outcome).toMatchObject({ name: "TimeoutError" });
    expect(existsSync(socket)).toBe(true);
    expect(existsSync(pid)).toBe(true);
    const contender = new LspDaemon(socket, pid, 60_000, undefined, { backends: [] });
    onTestFinished(() => contender.shutdown());
    await expect(contender.start()).rejects.toThrow();
    release();
  }
  await daemon.shutdown();
  expect(existsSync(socket)).toBe(false);
  expect(existsSync(pid)).toBe(false);
});

it("isolates built CLI owners and recovers after a crash using runtime configuration", async () => {
  const root = TempDir.forTestSync("lsp-cli-");
  vi.stubEnv("PI_ENV_LSP_DIR", root);
  const paths = daemonPaths();
  // Fail before launch if namespace resolution could reach live user artifacts.
  expect(dirname(paths.socketPath)).toBe(root);
  expect(dirname(paths.pidPath)).toBe(root);
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: join(root, "agent"),
    PI_ENV_TOOLING_OTEL_ENABLED: "false",
    PI_LSP_IDLE_TIMEOUT_MS: "60000",
  };
  const entry = fileURLToPath(
    new URL("../../extensions/dev-tools/dist/daemon.js", import.meta.url),
  );
  const owners = [];
  const clients = [];
  onTestFinished(async () => {
    for (const client of clients) client.close();
    for (const owner of owners) {
      if (owner.child.exitCode === null && owner.child.signalCode === null)
        owner.child.kill("SIGKILL");
      await owner.closed;
    }
    vi.unstubAllEnvs();
  });
  const start = () => {
    const child = spawn(node, [entry], { env, stdio: ["ignore", "ignore", "pipe"] });
    const owner = { child, closed: once(child, "close") };
    owners.push(owner);
    return owner;
  };
  const ready = async (owner) => {
    const client = new LspClient(undefined, undefined, {
      spawnDaemon: () => {
        throw new Error("Waiting for owned CLI");
      },
    });
    clients.push(client);
    await vi.waitFor(
      async () => {
        expect(await client.call({ action: "status" })).toMatchObject({
          pid: owner.child.pid,
          running: true,
        });
      },
      { timeout: 5_000 },
    );
    return client;
  };
  const first = start();
  const client = await ready(first);
  const competing = await Effect.runPromise(runProcess(node, [entry], { env, timeoutMs: 5_000 }));
  expect(competing.exitCode).toBe(1);
  expect(competing.stderr).toContain("Daemon failed to start");
  expect(readFileSync(paths.pidPath, "utf8")).toBe(String(first.child.pid));
  expect(await client.call({ action: "status" })).toMatchObject({ pid: first.child.pid });

  first.child.kill("SIGKILL");
  await first.closed;
  // Observe kernel release before asking a fresh process to reclaim stale paths.
  await Effect.runPromise(
    runProcess(
      "flock",
      ["--exclusive", "--timeout", "5", `${paths.socketPath}.lock`, node, "-e", ""],
      { timeoutMs: 6_000 },
    ),
  );
  const replacement = start();
  await ready(replacement);
  const stopped = await Effect.runPromise(runProcess(node, [script], { env }));
  expect(stopped).toMatchObject({ exitCode: 0, stderr: "" });
  await replacement.closed;
  expect(existsSync(paths.socketPath)).toBe(false);
  expect(existsSync(paths.pidPath)).toBe(false);
});
