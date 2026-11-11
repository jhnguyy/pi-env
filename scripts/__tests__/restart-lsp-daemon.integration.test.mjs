import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { expect, it, onTestFinished } from "vitest";
import * as TempDir from "../../src/testing/temp-dir.ts";
import { runProcess } from "../../src/process/platform.ts";
import { LspDaemon } from "../../extensions/dev-tools/daemon.ts";

const script = fileURLToPath(new URL("../restart-lsp-daemon.mjs", import.meta.url));

it("leaves an unrelated live PID and stale artifacts untouched", async () => {
  const root = TempDir.forTestSync("lsp-restart-");
  const socket = join(root, "daemon.sock");
  const pid = join(root, "daemon.pid");
  const sentinel = spawn(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
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
  const result = await Effect.runPromise(runProcess(process.execPath, [script, socket, pid]));
  expect(result.exitCode).toBe(0);
  const alive = once(sentinel.stdout, "data");
  sentinel.stdin.write("alive");
  expect(String((await alive)[0])).toBe("alive");
  expect(existsSync(pid)).toBe(true);
  expect(existsSync(socket)).toBe(true);
});

it("requests native daemon shutdown and waits for owned artifact release", async () => {
  const root = TempDir.forTestSync("lsp-restart-");
  const socket = join(root, "daemon.sock");
  const pid = join(root, "daemon.pid");
  const daemon = new LspDaemon(socket, pid, 60_000, undefined, { backends: [] });
  onTestFinished(() => daemon.shutdown());
  await daemon.start();
  const result = await Effect.runPromise(runProcess(process.execPath, [script, socket, pid]));
  expect(result).toMatchObject({ exitCode: 0, stderr: "" });
  expect(existsSync(socket)).toBe(false);
  expect(existsSync(pid)).toBe(false);
});
